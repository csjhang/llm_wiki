//! Claude Code CLI subprocess transport.
//!
//! Users with a Claude Code subscription already have OAuth credentials
//! in ~/.claude/ and the `claude` binary on PATH. This module lets LLM
//! Wiki reuse that subscription instead of requiring a separate API key.
//! We treat `claude` purely as a text-completion engine — its agent
//! tools, MCPs, file-edit abilities, and --resume session state are all
//! out of scope. Multi-turn history is reconstructed from `messages`
//! on every call, symmetric with every other provider.
//!
//! Why tokio::process directly (not tauri-plugin-shell): the plugin's
//! scope model is designed for sidecars or fixed absolute paths; scoping
//! a user-installed PATH binary cleanly is awkward. A hardcoded Rust
//! command that always and only spawns `claude` provides the same
//! security property (the webview can't call this command to execute
//! anything else) without pulling in another plugin or editing
//! capabilities JSON.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::Mutex;

use super::cli_resolver::{
    child_path_env, cli_version_timeout_error, find_cli_command, CLI_VERSION_PROBE_TIMEOUT,
};

const ISOLATED_MCP_CONFIG: &str = "{\"mcpServers\":{}}";

/// Shared state holding running `claude` child processes keyed by the
/// frontend-generated stream id. Registered via .manage() in lib.rs.
#[derive(Default)]
pub struct ClaudeCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Serialize)]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    /// When !installed, a short human-readable reason (missing from PATH,
    /// quarantined on macOS, spawn failed, etc). The frontend shows this
    /// verbatim in the status pill.
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct ClaudeMessage {
    /// "system" | "user" | "assistant"
    role: String,
    content: ClaudeContent,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum ClaudeContent {
    Text(String),
    Blocks(Vec<ClaudeContentBlock>),
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type")]
enum ClaudeContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mediaType")]
        media_type: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
}

fn claude_content_text_only(content: &ClaudeContent) -> String {
    match content {
        ClaudeContent::Text(text) => text.clone(),
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                ClaudeContentBlock::Text { text } => Some(text.as_str()),
                ClaudeContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

fn claude_content_blocks(content: &ClaudeContent) -> Vec<serde_json::Value> {
    match content {
        ClaudeContent::Text(text) => vec![serde_json::json!({ "type": "text", "text": text })],
        ClaudeContent::Blocks(blocks) => blocks
            .iter()
            .map(|block| match block {
                ClaudeContentBlock::Text { text } => {
                    serde_json::json!({ "type": "text", "text": text })
                }
                ClaudeContentBlock::Image {
                    media_type,
                    data_base64,
                } => serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": data_base64,
                    },
                }),
            })
            .collect(),
    }
}

/// Fold the system preamble into an existing user text block. Claude Code's
/// prompt-injection guard can reject a standalone user content block that
/// looks like a role override, even though the CLI has no portable system
/// prompt flag across supported versions. Image-only turns have no text to
/// merge into, so they receive one leading text block as a necessary fallback.
fn merge_system_preamble_into_user_content(
    content: &mut Vec<serde_json::Value>,
    system_preamble: &str,
) {
    if system_preamble.is_empty() {
        return;
    }

    for block in content.iter_mut() {
        if block.get("type").and_then(serde_json::Value::as_str) != Some("text") {
            continue;
        }
        let Some(existing) = block
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        *block = serde_json::json!({
            "type": "text",
            "text": format!("{system_preamble}\n\n{existing}"),
        });
        return;
    }

    content.insert(
        0,
        serde_json::json!({ "type": "text", "text": system_preamble }),
    );
}

async fn find_claude_command() -> Result<PathBuf, String> {
    find_cli_command("claude", &["claude.cmd", "claude.exe"]).await
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Locate `claude` on PATH and confirm it's runnable by calling
/// `claude --version` with a bounded timeout. Safe to call on
/// mount of the settings panel.
#[tauri::command]
pub async fn claude_cli_detect() -> Result<DetectResult, String> {
    let path = match find_claude_command().await {
        Ok(p) => p,
        Err(error) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: None,
                error: Some(error),
            });
        }
    };

    let path_str = path.to_string_lossy().to_string();

    let mut cmd = Command::new(&path);
    suppress_windows_console(&mut cmd);
    // npm-installed Claude is a Node shim. Desktop apps do not inherit the
    // user's login-shell PATH, so detection and execution must both supply it.
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    let output =
        tokio::time::timeout(CLI_VERSION_PROBE_TIMEOUT, cmd.arg("--version").output()).await;

    match output {
        Ok(Ok(out)) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(DetectResult {
                installed: true,
                version: Some(version),
                path: Some(path_str),
                error: None,
            })
        }
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            // macOS Gatekeeper quarantines produce a predictable error. If
            // we detect it, surface the remediation hint directly; the UI
            // renders this string into an actionable message.
            let error = if stderr.contains("quarantine") || stderr.contains("damaged") {
                Some(format!(
                    "Binary quarantined — try: xattr -d com.apple.quarantine {path_str}"
                ))
            } else if stderr.is_empty() {
                Some(format!("`claude --version` exited with {}", out.status))
            } else {
                Some(stderr)
            };
            Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                error,
            })
        }
        Ok(Err(e)) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(format!("Failed to spawn `claude`: {e}")),
        }),
        Err(_) => Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            error: Some(cli_version_timeout_error("claude")),
        }),
    }
}

/// Spawn `claude -p --output-format stream-json --input-format stream-json
/// --verbose --model <model>` and pipe stdout back to the frontend as
/// `claude-cli:{stream_id}` events (one line per event). Closes stdin
/// after writing the serialized history so claude starts processing.
/// Emits a final `claude-cli:{stream_id}:done` event with `{ code }`
/// when the child exits.
#[tauri::command]
pub async fn claude_cli_spawn(
    app: AppHandle,
    state: State<'_, ClaudeCliState>,
    stream_id: String,
    model: String,
    messages: Vec<ClaudeMessage>,
    isolate_local_config: bool,
    working_directory: Option<String>,
) -> Result<(), String> {
    // Build the turn list: fold any system messages into a preamble on
    // the first user turn rather than using a CLI flag, because
    // --system-prompt / --append-system-prompt availability varies
    // across claude CLI versions. Inlining works on every version.
    let system_preamble: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| claude_content_text_only(&m.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let conversation: Vec<&ClaudeMessage> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .collect();

    if conversation.is_empty() {
        return Err("No user/assistant messages to send to claude CLI".to_string());
    }

    // Synthesize turns with the preamble merged into the first user turn.
    let mut first_user_seen = false;
    let turns: Vec<(String, Vec<serde_json::Value>)> = conversation
        .iter()
        .map(|m| {
            let role = m.role.clone();
            let mut content = claude_content_blocks(&m.content);
            if !first_user_seen && role == "user" && !system_preamble.is_empty() {
                merge_system_preamble_into_user_content(&mut content, &system_preamble);
                first_user_seen = true;
            }
            (role, content)
        })
        .collect();

    let working_directory = resolve_claude_working_directory(working_directory).await?;
    let claude = find_claude_command().await?;
    let mut cmd = Command::new(&claude);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.args(build_claude_cli_args(&model, isolate_local_config));
    cmd.current_dir(&working_directory);

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    // Serialize turns to stdin then close. stream-json input format
    // expects one JSON event per line. Conversation history is laid out
    // in order; the final user turn triggers claude's response.
    //
    // `content` MUST be an array of blocks, not a plain string. The CLI
    // iterates content blocks looking for `tool_use_id` and crashes with
    // `W is not an Object. (evaluating '"tool_use_id"in W')` if it
    // encounters a raw string. User turns silently tolerated a string
    // in light testing, but assistant turns reject it immediately, so
    // we normalize both roles to the block-array form.
    for (role, content) in &turns {
        let event = serde_json::json!({
            "type": role,
            "message": {
                "role": role,
                "content": content,
            }
        });
        let line = format!("{}\n", event);
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to claude stdin: {e}"))?;
    }
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush claude stdin: {e}"))?;
    drop(stdin);

    register_and_drain(
        app,
        Arc::clone(&state.children),
        stream_id,
        child,
        stdout,
        stderr,
    )
    .await;

    Ok(())
}

/// Register the child so `claude_cli_kill` can reach it, then drain its output in a
/// background task. Both spawn commands end here, so the two share one event protocol:
/// `claude-cli:{stream_id}` carries one stdout line per event, and
/// `claude-cli:{stream_id}:done` carries `{ code, stderr }` when the child exits.
async fn register_and_drain(
    app: AppHandle,
    children: Arc<Mutex<HashMap<String, Child>>>,
    stream_id: String,
    child: Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
) {
    // Register the child so `claude_cli_kill` can reach it.
    children.lock().await.insert(stream_id.clone(), child);

    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let topic = format!("claude-cli:{stream_id}");
    let done_topic = format!("claude-cli:{stream_id}:done");

    // Drain stdout line-by-line in a background task, emitting each
    // line as an event. Completes when stdout closes (child exited).
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app = app_for_task;

        // Collect stderr in a background task so we can ship it with the
        // final :done event — otherwise a non-zero exit produces only
        // "exited with code N" with no diagnostic info on the frontend.
        // Also echo each line to the tauri dev terminal so the developer
        // can watch the CLI's stderr live while iterating.
        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[claude-cli stderr] {line}");
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        });

        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if app.emit(&topic, line).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[claude-cli stdout] read error: {e}");
                    break;
                }
            }
        }

        // Wait for the child to fully exit so we can report its code.
        // Don't hold the map lock across .wait() — kill could race.
        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            // Already removed by claude_cli_kill — leave code as None.
            None
        };

        let stderr_text = stderr_task.await.unwrap_or_default();

        let _ = app.emit(
            &done_topic,
            serde_json::json!({
                "code": exit_code,
                "stderr": stderr_text,
            }),
        );
    });
}

/// Plain characters only: a skill command is a slash command and its words. This is the
/// same list as the skill panel uses for its words (letters, digits, `.`, `_`, `/`, `-`),
/// plus the single space between words. `claude` gets the command as one argument and no
/// shell reads it, and this list keeps it safe for the `.cmd` shim on Windows too.
fn is_plain_skill_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-' | ' ')
}

/// A skill command starts with `/`, so `claude` cannot read it as an option, and has only plain characters.
fn validate_skill_command(command: &str) -> Result<(), String> {
    if !command.starts_with('/') {
        return Err("A skill command must start with \"/\"".to_string());
    }
    if let Some(bad) = command.chars().find(|c| !is_plain_skill_char(*c)) {
        return Err(format!(
            "A skill command may have letters, digits, \".\", \"_\", \"/\", \"-\", and spaces only; found {bad:?}"
        ));
    }
    Ok(())
}

/// `claude -p --output-format stream-json --verbose <command>`.
///
/// A skill run keeps the user's own Claude Code setup: no `--setting-sources`, no
/// `--disable-slash-commands`, no `--tools`, and no `--mcp-config` flag. So the plugins,
/// the MCP servers, and the settings of the project apply, and the skill can run as a
/// slash command. It has no `--model` flag, so Claude Code uses its own default model.
/// It has no permission flag either: a tool that the settings do not allow is denied,
/// because nobody can answer a prompt. The command is the last argument.
fn build_claude_skill_args(command: &str) -> Result<Vec<String>, String> {
    validate_skill_command(command)?;
    Ok(vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        command.to_string(),
    ])
}

/// Run one skill in the background: `claude -p "<command>"` in the project folder, with the
/// user's Claude Code setup (see `build_claude_skill_args`). Output goes to the frontend as
/// `claude_cli_spawn` sends it: `claude-cli:{stream_id}` events, then `claude-cli:{stream_id}:done`.
/// `claude_cli_kill` stops the run.
#[tauri::command]
pub async fn claude_cli_run_skill(
    app: AppHandle,
    state: State<'_, ClaudeCliState>,
    stream_id: String,
    command: String,
    working_directory: Option<String>,
) -> Result<(), String> {
    let args = build_claude_skill_args(&command)?;
    let working_directory = resolve_claude_working_directory(working_directory).await?;
    let claude = find_claude_command().await?;
    let mut cmd = Command::new(&claude);
    suppress_windows_console(&mut cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
    cmd.args(args);
    cmd.current_dir(&working_directory);

    // No input: a skill run asks nobody. Piped stdin would also make claude wait a few seconds for data.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    register_and_drain(
        app,
        Arc::clone(&state.children),
        stream_id,
        child,
        stdout,
        stderr,
    )
    .await;

    Ok(())
}

fn build_claude_cli_args(model: &str, isolate_local_config: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];

    if isolate_local_config {
        // Claude has no documented "empty setting sources" mode. Keep the
        // narrow project source so explicit project-level Claude settings can
        // still apply, while user/global config, MCP, tools, sessions, and
        // slash commands are constrained below.
        args.extend([
            "--setting-sources".to_string(),
            "project".to_string(),
            "--disable-slash-commands".to_string(),
            "--tools".to_string(),
            "".to_string(),
            "--no-session-persistence".to_string(),
            "--prompt-suggestions".to_string(),
            "false".to_string(),
        ]);
    }

    args.extend(["--model".to_string(), model.to_string()]);
    if isolate_local_config {
        // `--mcp-config` accepts multiple space-separated values. Keep its
        // inline JSON last so Claude's argument parser cannot consume later
        // flags as additional config paths, especially through Windows shims.
        args.extend([
            "--strict-mcp-config".to_string(),
            "--mcp-config".to_string(),
            ISOLATED_MCP_CONFIG.to_string(),
        ]);
    }
    args
}

async fn resolve_claude_working_directory(value: Option<String>) -> Result<PathBuf, String> {
    let raw = value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            "Claude Code CLI requires an active project working directory".to_string()
        })?;
    let path = Path::new(raw.as_str());
    if !path.is_absolute() {
        return Err(
            "Claude Code CLI working directory must be an absolute project path".to_string(),
        );
    }
    let path_meta = tokio::fs::metadata(path).await.map_err(|e| {
        eprintln!("[claude-cli] failed to read working directory metadata {raw}: {e}");
        format!("Claude Code CLI working directory does not exist or cannot be read: {raw}")
    })?;
    if !path_meta.is_dir() {
        return Err(format!(
            "Claude Code CLI working directory is not a directory: {raw}"
        ));
    }
    let index_path = path.join("wiki").join("index.md");
    let index_meta = tokio::fs::metadata(&index_path).await.map_err(|e| {
        eprintln!("[claude-cli] failed to read wiki/index.md metadata for {raw}: {e}");
        format!("Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}")
    })?;
    if !index_meta.is_file() {
        return Err(format!(
            "Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: {raw}"
        ));
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|e| format!("Failed to canonicalize Claude Code CLI working directory {raw}: {e}"))
}

/// Kill a running child registered under `stream_id`. Called on
/// AbortSignal in the frontend. No-op if the id is unknown (e.g. the
/// process already exited).
#[tauri::command]
pub async fn claude_cli_kill(
    state: State<'_, ClaudeCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        let _ = child.start_kill();
        // Don't wait() here — the stdout-drain task already holds a
        // wait future elsewhere when it can. Dropping the handle is
        // enough; kill_on_drop ensures the SIGKILL is sent.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_content_blocks_maps_frontend_image_blocks_to_anthropic_shape() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "describe this" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        let blocks = claude_content_blocks(&content);

        assert_eq!(
            blocks,
            vec![
                serde_json::json!({ "type": "text", "text": "describe this" }),
                serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123",
                    },
                }),
            ]
        );
    }

    #[test]
    fn system_text_drops_images_before_inlining_preamble() {
        let content: ClaudeContent = serde_json::from_value(serde_json::json!([
            { "type": "text", "text": "system rule" },
            { "type": "image", "mediaType": "image/png", "dataBase64": "abc123" }
        ]))
        .expect("content block payload should deserialize");

        assert_eq!(claude_content_text_only(&content), "system rule");
    }

    #[test]
    fn system_preamble_merges_into_existing_user_text_block() {
        let mut blocks = vec![
            serde_json::json!({ "type": "text", "text": "Output the token" }),
            serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": "abc123" },
            }),
        ];

        merge_system_preamble_into_user_content(&mut blocks, "System instructions");

        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0],
            serde_json::json!({
                "type": "text",
                "text": "System instructions\n\nOutput the token",
            })
        );
        assert_eq!(
            blocks[1].get("type").and_then(serde_json::Value::as_str),
            Some("image")
        );
    }

    #[test]
    fn system_preamble_adds_text_block_only_for_image_only_turn() {
        let mut blocks = vec![serde_json::json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": "abc123" },
        })];

        merge_system_preamble_into_user_content(&mut blocks, "System instructions");

        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0],
            serde_json::json!({ "type": "text", "text": "System instructions" })
        );
        assert_eq!(
            blocks[1].get("type").and_then(serde_json::Value::as_str),
            Some("image")
        );
    }

    #[test]
    fn claude_args_do_not_isolate_local_config_by_default() {
        let args = build_claude_cli_args("sonnet", false);

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"sonnet".to_string()));
        assert!(!args.contains(&"--setting-sources".to_string()));
        assert!(!args.contains(&"--strict-mcp-config".to_string()));
        assert!(!args.contains(&"--mcp-config".to_string()));
        assert!(!args.contains(&"--disable-slash-commands".to_string()));
    }

    #[test]
    fn claude_args_can_isolate_user_config_tools_and_mcp() {
        assert_eq!(ISOLATED_MCP_CONFIG, "{\"mcpServers\":{}}");
        let parsed: serde_json::Value =
            serde_json::from_str(ISOLATED_MCP_CONFIG).expect("isolated MCP config is valid JSON");
        assert!(parsed
            .get("mcpServers")
            .and_then(|value| value.as_object())
            .is_some_and(|servers| servers.is_empty()));

        let args = build_claude_cli_args("sonnet", true);

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--setting-sources" && pair[1] == "project"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--mcp-config" && pair[1] == ISOLATED_MCP_CONFIG));
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--tools" && pair[1].is_empty()));
        assert!(args.contains(&"--no-session-persistence".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--prompt-suggestions" && pair[1] == "false"));
        assert_eq!(
            &args[args.len() - 3..],
            ["--strict-mcp-config", "--mcp-config", ISOLATED_MCP_CONFIG]
        );
    }

    #[test]
    fn claude_skill_args_run_the_command_as_the_prompt() {
        let args = build_claude_skill_args("/wiki-sync --yes").expect("a plain slash command");

        assert_eq!(
            args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "/wiki-sync --yes"
            ]
        );
    }

    #[test]
    fn claude_skill_args_keep_user_config_and_never_skip_permissions() {
        let args = build_claude_skill_args("/wiki-lint").expect("a plain slash command");

        // The skill needs the slash command, the tools, and the MCP servers of the user.
        for flag in [
            "--setting-sources",
            "--disable-slash-commands",
            "--tools",
            "--strict-mcp-config",
            "--mcp-config",
            "--input-format",
            "--model",
        ] {
            assert!(!args.contains(&flag.to_string()), "unexpected flag {flag}");
        }
        // A tool that the settings do not allow stays denied.
        assert!(!args
            .iter()
            .any(|arg| arg.contains("permission") || arg.contains("dangerously")));
        // The command is the last item, so no flag after it can be read as part of it.
        assert_eq!(args.last().map(String::as_str), Some("/wiki-lint"));
    }

    #[test]
    fn claude_skill_command_must_be_a_plain_slash_command() {
        for ok in [
            "/wiki-lint",
            "/wiki-sync --yes",
            "/wiki-fuse 00000000-0000-4000-8000-000000000001",
            "/wiki-recut some/relative_path.md",
        ] {
            assert!(validate_skill_command(ok).is_ok(), "should accept {ok}");
        }
        for bad in [
            "",
            "   ",
            "wiki-sync",
            "--help",
            "-p",
            " /wiki-sync",
            "/wiki-sync; rm -rf x",
            "/wiki-sync\n--yes",
            "/wiki-sync\r",
            "/wiki-sync $(id)",
            "/wiki-sync `id`",
            "/wiki-sync \"x\"",
            "/wiki-sync 'x'",
            "/wiki-sync a|b",
            "/wiki-sync a&b",
            "/wiki-sync a>b",
            "/wiki-sync %PATH%",
            "/wiki-sync C:\\x",
            "/wiki-sync \u{e9}",
        ] {
            assert!(
                validate_skill_command(bad).is_err(),
                "should refuse {bad:?}"
            );
            assert!(
                build_claude_skill_args(bad).is_err(),
                "args should refuse {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn claude_working_directory_requires_llm_wiki_project() {
        assert!(resolve_claude_working_directory(None)
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(resolve_claude_working_directory(Some("".to_string()))
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(resolve_claude_working_directory(Some("   ".to_string()))
            .await
            .unwrap_err()
            .contains("active project"));
        assert!(
            resolve_claude_working_directory(Some("relative/path".to_string()))
                .await
                .unwrap_err()
                .contains("absolute")
        );

        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-claude-cwd-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let raw = dir.to_string_lossy().to_string();

        assert!(resolve_claude_working_directory(Some(raw.clone()))
            .await
            .unwrap_err()
            .contains("wiki/index.md"));

        let wiki_dir = dir.join("wiki");
        std::fs::create_dir_all(&wiki_dir).expect("wiki dir");
        let index_dir = wiki_dir.join("index.md");
        std::fs::create_dir_all(&index_dir).expect("index dir");
        assert!(resolve_claude_working_directory(Some(raw.clone()))
            .await
            .unwrap_err()
            .contains("wiki/index.md"));
        std::fs::remove_dir_all(&index_dir).expect("remove index dir");
        std::fs::write(wiki_dir.join("index.md"), "# Index\n").expect("index");

        let resolved = resolve_claude_working_directory(Some(raw))
            .await
            .expect("valid project path");
        assert_eq!(resolved, dir.canonicalize().expect("canonical tempdir"));

        std::fs::remove_dir_all(&dir).expect("cleanup temp dir");
    }
}
