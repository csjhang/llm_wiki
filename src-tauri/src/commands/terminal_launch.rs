//! Open Claude Code in a terminal window.
//!
//! The skill panel runs a conversation skill in a real terminal, so the user
//! can answer its questions. This module builds the launcher command lines and
//! starts the first one that works.
//!
//! The builders are pure functions. They never call the OS, so the tests run
//! on every platform. Both inputs are untrusted text, and each builder checks
//! them again (defence in depth): a control character, a relative path, or a
//! command that is not a slash command is refused with a clear error.
//!
//! Wherever a launcher takes an argument list, the text goes in as one list
//! item and no shell reads it. Where a shell or AppleScript string cannot be
//! avoided, one tested function quotes it for that layer.

use std::io::ErrorKind;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Fixed script for terminals that only run `-e program args...` and have no
/// "working folder" option. The folder is `$1` and the command is `$2`: they
/// are list items after `sh -c <script> sh`, so no shell ever reads them as
/// code. If `claude` is missing, say so and wait, so the window does not close
/// before the user can read why.
const LINUX_SCRIPT: &str = r#"cd "$1" && command -v claude >/dev/null 2>&1 && exec claude "$2"; echo "Could not start Claude Code in $1. Press Enter to close."; read -r _"#;

/// Characters `cmd` reads as syntax (or as an argument separator) even when the
/// text came from a plain argument list. Both Windows launchers end in
/// `cmd /k claude <command>`, and Windows has no safe way to quote these for
/// `cmd`, so the text must not have one. `"` ends a quoted argument early, and
/// `;` splits a `wt` command line.
const CMD_REFUSED: [char; 11] = ['&', '|', '<', '>', '^', '%', '"', '!', ';', ',', '='];

/// One way to start a terminal: a program, its argument list, and how to run it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: &'static str,
    pub args: Vec<String>,
    /// Wait for the program and check its exit code. Only for a launcher that
    /// returns at once (`osascript`); a terminal emulator may run for hours.
    pub wait: bool,
}

// ---- checks on the two inputs ----

fn check_text(name: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("{name} is empty"));
    }
    if text
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
    {
        return Err(format!(
            "{name} must not have a line break or other control character"
        ));
    }
    Ok(())
}

/// True for `/x`, `\x`, `\\server\share`, and `C:\x` or `C:/x`.
fn is_absolute_like(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with('\\')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'))
}

/// Every builder calls this first. An absolute path cannot be read as an
/// option by `cd`. A slash command cannot be read as an option by `claude`.
fn validate(project_path: &str, command: &str) -> Result<(), String> {
    check_text("project path", project_path)?;
    check_text("command", command)?;
    if !is_absolute_like(project_path) {
        return Err(format!(
            "project path must be an absolute path: {project_path}"
        ));
    }
    if !command.starts_with('/') {
        return Err("command must be a slash command that starts with \"/\"".to_string());
    }
    Ok(())
}

// ---- the two quoting layers ----

/// Quote text for a POSIX shell: single quotes, with `'\''` for each `'`.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Quote text as an AppleScript string literal: escape `\` and `"`.
pub fn applescript_quote(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

// ---- macOS ----

/// The lines of the AppleScript that opens Terminal, runs `claude`, and brings
/// Terminal to the front. The text goes through `shell_quote`, and the whole
/// shell line then goes through `applescript_quote`.
pub fn build_macos_script(project_path: &str, command: &str) -> Result<Vec<String>, String> {
    validate(project_path, command)?;
    let shell_line = format!(
        "cd {} && claude {}",
        shell_quote(project_path),
        shell_quote(command)
    );
    Ok(vec![
        format!(
            "tell application \"Terminal\" to do script {}",
            applescript_quote(&shell_line)
        ),
        "tell application \"Terminal\" to activate".to_string(),
    ])
}

/// `osascript -e <line> -e <line>`.
fn macos_launch(project_path: &str, command: &str) -> Result<Launch, String> {
    let args = build_macos_script(project_path, command)?
        .into_iter()
        .flat_map(|line| ["-e".to_string(), line])
        .collect();
    Ok(Launch {
        program: "osascript",
        args,
        wait: true,
    })
}

// ---- Windows ----

/// Backslashes, and no trailing one: `cmd` does not undo the escape that Rust
/// adds before a closing quote. A drive root keeps its backslash (`C:` alone
/// means "the current folder on C").
fn windows_path(path: &str) -> String {
    let flipped = path.replace('/', "\\");
    let trimmed = flipped.trim_end_matches('\\');
    if trimmed.is_empty() {
        "\\".to_string()
    } else if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    }
}

/// `wt -d <path> cmd /k claude <command>`, then `cmd /c start "" /D <path> cmd
/// /k claude <command>`. Both take an argument list. `claude` runs through
/// `cmd` so that `claude.cmd` (the npm install) is found. `cmd` re-reads its
/// command line, so text with a character `cmd` treats as syntax is refused.
/// A UNC path is refused too: `cmd` cannot make it the working folder.
pub fn build_windows_args(project_path: &str, command: &str) -> Result<Vec<Launch>, String> {
    validate(project_path, command)?;
    let path = windows_path(project_path);
    if path.starts_with("\\\\") {
        return Err(
            "project path must not be a UNC path (\\\\server\\share); use a path that starts with a drive letter"
                .to_string(),
        );
    }
    if path.contains(CMD_REFUSED) || command.contains(CMD_REFUSED) {
        return Err(format!(
            "project path and command must not have any of these characters on Windows: {}",
            CMD_REFUSED.iter().collect::<String>()
        ));
    }

    Ok(vec![
        Launch {
            program: "wt",
            args: ["-d", &path, "cmd", "/k", "claude", command]
                .iter()
                .map(|arg| arg.to_string())
                .collect(),
            wait: false,
        },
        Launch {
            program: "cmd",
            args: [
                "/c", "start", "", "/D", &path, "cmd", "/k", "claude", command,
            ]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
            wait: false,
        },
    ])
}

// ---- Linux ----

/// The terminals to try, in order: `x-terminal-emulator`, `gnome-terminal`,
/// `konsole`, `xterm`. Each one gets its own way to set the working folder and
/// to run a program with arguments.
pub fn linux_candidates(project_path: &str, command: &str) -> Result<Vec<Launch>, String> {
    validate(project_path, command)?;
    let with_script = |program: &'static str| Launch {
        program,
        args: ["-e", "sh", "-c", LINUX_SCRIPT, "sh", project_path, command]
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        wait: false,
    };
    Ok(vec![
        with_script("x-terminal-emulator"),
        Launch {
            program: "gnome-terminal",
            args: vec![
                format!("--working-directory={project_path}"),
                "--".to_string(),
                "claude".to_string(),
                command.to_string(),
            ],
            wait: false,
        },
        Launch {
            program: "konsole",
            args: vec![
                "--workdir".to_string(),
                project_path.to_string(),
                "-e".to_string(),
                "claude".to_string(),
                command.to_string(),
            ],
            wait: false,
        },
        with_script("xterm"),
    ])
}

// ---- starting a terminal ----

fn candidates_for_host(project_path: &str, command: &str) -> Result<Vec<Launch>, String> {
    if cfg!(target_os = "macos") {
        Ok(vec![macos_launch(project_path, command)?])
    } else if cfg!(windows) {
        build_windows_args(project_path, command)
    } else {
        linux_candidates(project_path, command)
    }
}

/// Run the candidates in order. Returns the name of the first one that starts.
/// When none starts, the error names each one and says why, so the caller can
/// offer to copy the command instead.
fn launch_first(
    candidates: &[Launch],
    mut run: impl FnMut(&Launch) -> Result<(), String>,
) -> Result<String, String> {
    let mut failures = Vec::new();
    for launch in candidates {
        match run(launch) {
            Ok(()) => return Ok(launch.program.to_string()),
            Err(reason) => failures.push(format!("{}: {}", launch.program, reason)),
        }
    }
    Err(format!(
        "Could not open a terminal ({}). Copy the command and run it in a terminal yourself.",
        failures.join("; ")
    ))
}

fn run_launch(launch: &Launch) -> Result<(), String> {
    let describe = |error: std::io::Error| {
        if error.kind() == ErrorKind::NotFound {
            "not found".to_string()
        } else {
            error.to_string()
        }
    };
    let mut command = Command::new(launch.program);
    command.args(&launch.args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        // `cmd` is only the helper that runs `start`. Its own console stays hidden.
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if launch.program == "cmd" {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }

    if launch.wait {
        let output = command.output().map_err(describe)?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{}: {}", output.status, stderr.trim()));
    }

    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(describe)?;
    // A terminal can run for hours. Wait on a thread so a finished one never
    // stays a zombie process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Open Claude Code with `command` (for example `/wiki-fuse <id>`) in a new
/// terminal window, in the project folder. Returns the name of the launcher
/// used. The error says why no terminal started; the caller then offers to copy
/// the command.
#[tauri::command(async)]
pub fn open_claude_terminal(project_path: String, command: String) -> Result<String, String> {
    let candidates = candidates_for_host(&project_path, &command)?;
    if !Path::new(&project_path).is_dir() {
        return Err(format!("The project folder was not found: {project_path}"));
    }
    launch_first(&candidates, run_launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/Users/me/My Project";
    const COMMAND: &str = "/wiki-fuse 00000000-0000-4000-8000-000000000001";
    /// A path with a space, a single quote, a double quote, `$`, and a backtick.
    const HOSTILE_PATH: &str = "/Users/me/it's \"mine\" $HOME `id`";

    fn programs(list: &[Launch]) -> Vec<&'static str> {
        list.iter().map(|launch| launch.program).collect()
    }

    // ---- control characters and shape of the input ----

    #[test]
    fn rejects_newlines_in_the_command_for_every_builder() {
        for bad in [
            "/wiki-fuse x\nrm -rf ~",
            "/wiki-fuse x\r",
            "/wiki-fuse\u{0}x",
        ] {
            let message = build_macos_script(PATH, bad).unwrap_err();
            assert!(message.contains("control character"), "{message}");
            assert!(build_windows_args(PATH, bad).is_err(), "windows: {bad:?}");
            assert!(linux_candidates(PATH, bad).is_err(), "linux: {bad:?}");
        }
    }

    #[test]
    fn rejects_newlines_in_the_path_for_every_builder() {
        for bad in [
            "/Users/me\n/x",
            "/Users/me\r/x",
            "/Users/\u{0}me",
            "/Users/me\t/x",
            "/Users/me\u{7f}/x",
            "/Users/me\u{2028}/x",
            "/Users/me\u{2029}/x",
        ] {
            assert!(build_macos_script(bad, COMMAND).is_err(), "macos: {bad:?}");
            assert!(
                build_windows_args(bad, COMMAND).is_err(),
                "windows: {bad:?}"
            );
            assert!(linux_candidates(bad, COMMAND).is_err(), "linux: {bad:?}");
        }
    }

    #[test]
    fn rejects_tab_delete_and_unicode_line_separators() {
        for bad in [
            "/wiki-fuse\tx",
            "/wiki-fuse\u{7f}",
            "/wiki-fuse\u{2028}x",
            "/wiki-fuse\u{2029}x",
        ] {
            assert!(linux_candidates(PATH, bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rejects_empty_text() {
        assert!(linux_candidates("", COMMAND).is_err());
        assert!(linux_candidates(PATH, "").is_err());
        assert!(linux_candidates(PATH, "   ").is_err());
    }

    #[test]
    fn rejects_a_relative_path() {
        for bad in ["wiki", "./wiki", "-rf", "~/wiki", "C:wiki"] {
            let message = linux_candidates(bad, COMMAND).unwrap_err();
            assert!(message.contains("absolute"), "{bad}: {message}");
            assert!(build_macos_script(bad, COMMAND).is_err(), "macos: {bad}");
            assert!(build_windows_args(bad, COMMAND).is_err(), "windows: {bad}");
        }
    }

    #[test]
    fn rejects_a_command_that_could_be_an_option() {
        for bad in ["--dangerously-skip-permissions", "-p x", "wiki-fuse x"] {
            let message = linux_candidates(PATH, bad).unwrap_err();
            assert!(message.contains("slash command"), "{bad}: {message}");
            assert!(build_macos_script(PATH, bad).is_err(), "macos: {bad}");
            assert!(build_windows_args(PATH, bad).is_err(), "windows: {bad}");
        }
    }

    // ---- the two quoting layers ----

    #[test]
    fn shell_quote_wraps_in_single_quotes() {
        assert_eq!(
            shell_quote("/Users/me/My Project"),
            "'/Users/me/My Project'"
        );
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        assert_eq!(shell_quote("''"), r"''\'''\'''");
        assert_eq!(
            shell_quote(HOSTILE_PATH),
            "'/Users/me/it'\\''s \"mine\" $HOME `id`'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_quote_survives_a_real_shell() {
        for text in [
            "/Users/me/My Project",
            "it's",
            "\"double\"",
            "$HOME and ${PATH}",
            "`id` and $(id)",
            "back\\slash \\' \\\"",
            "semi; colon && pipe | star * glob ?",
            "ünïcode 空白",
            HOSTILE_PATH,
        ] {
            let output = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("printf %s {}", shell_quote(text)))
                .output()
                .expect("run sh");
            assert_eq!(String::from_utf8_lossy(&output.stdout), text);
        }
    }

    #[test]
    fn applescript_quote_escapes_backslash_and_double_quote() {
        assert_eq!(applescript_quote("plain"), "\"plain\"");
        assert_eq!(applescript_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(applescript_quote("a\\b"), "\"a\\\\b\"");
        assert_eq!(applescript_quote("\\\""), "\"\\\\\\\"\"");
    }

    /// Read an AppleScript string literal back: the inverse of `applescript_quote`.
    fn applescript_unquote(literal: &str) -> String {
        let inner = literal
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .expect("a quoted literal");
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => out.push(chars.next().expect("an escaped character")),
                '"' => panic!("unescaped double quote in {literal}"),
                other => out.push(other),
            }
        }
        out
    }

    #[test]
    fn applescript_quote_round_trips() {
        for text in [
            "plain",
            "a\"b",
            "a\\b",
            "\\\"\\",
            "it's $x `y`",
            HOSTILE_PATH,
        ] {
            assert_eq!(applescript_unquote(&applescript_quote(text)), text);
        }
    }

    // ---- macOS ----

    #[test]
    fn macos_script_cds_then_runs_claude() {
        let lines = build_macos_script(PATH, COMMAND).unwrap();
        assert_eq!(
            lines,
            vec![
                "tell application \"Terminal\" to do script \"cd '/Users/me/My Project' && claude '/wiki-fuse 00000000-0000-4000-8000-000000000001'\"".to_string(),
                "tell application \"Terminal\" to activate".to_string(),
            ]
        );
    }

    #[test]
    fn macos_script_quotes_paths_with_spaces_quotes_dollar_and_backticks() {
        let lines = build_macos_script(HOSTILE_PATH, COMMAND).unwrap();
        let prefix = "tell application \"Terminal\" to do script ";
        let literal = lines[0].strip_prefix(prefix).expect("do script line");
        // Undo the AppleScript layer: what Terminal types into the shell.
        let shell_line = applescript_unquote(literal);
        assert_eq!(
            shell_line,
            format!(
                "cd {} && claude {}",
                shell_quote(HOSTILE_PATH),
                shell_quote(COMMAND)
            )
        );
    }

    #[test]
    fn macos_launch_passes_each_script_line_after_dash_e() {
        let launch = macos_launch(PATH, COMMAND).unwrap();
        let lines = build_macos_script(PATH, COMMAND).unwrap();
        assert_eq!(launch.program, "osascript");
        assert!(launch.wait);
        assert_eq!(
            launch.args,
            vec![
                "-e".to_string(),
                lines[0].clone(),
                "-e".to_string(),
                lines[1].clone()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn macos_shell_line_changes_to_the_right_folder() {
        let base = std::env::temp_dir().join(format!("terminal-launch-{}", std::process::id()));
        let folder = base.join("it's \"mine\" $HOME `id`");
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.to_string_lossy().to_string();
        let lines = build_macos_script(&path, "/wiki-lint").unwrap();
        let literal = lines[0]
            .strip_prefix("tell application \"Terminal\" to do script ")
            .unwrap();
        let line = applescript_unquote(literal);
        // Swap `claude` for `pwd` so the real shell shows where it ended up.
        let probe = line.replace("&& claude '/wiki-lint'", "&& pwd -P");
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(&probe)
            .output()
            .unwrap();
        let printed = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        let expected = std::fs::canonicalize(&folder)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(printed, expected);
    }

    // ---- Windows ----

    #[test]
    fn windows_tries_wt_then_cmd() {
        let list = build_windows_args("C:\\Users\\me\\My Project", COMMAND).unwrap();
        assert_eq!(programs(&list), vec!["wt", "cmd"]);
        assert_eq!(
            list[0].args,
            vec![
                "-d",
                "C:\\Users\\me\\My Project",
                "cmd",
                "/k",
                "claude",
                COMMAND
            ]
        );
        assert_eq!(
            list[1].args,
            vec![
                "/c",
                "start",
                "",
                "/D",
                "C:\\Users\\me\\My Project",
                "cmd",
                "/k",
                "claude",
                COMMAND
            ]
        );
        assert!(list.iter().all(|launch| !launch.wait));
    }

    #[test]
    fn windows_turns_forward_slashes_into_backslashes() {
        let list = build_windows_args("C:/Users/me/My Project", COMMAND).unwrap();
        assert_eq!(list[0].args[1], "C:\\Users\\me\\My Project");
        assert_eq!(list[1].args[4], "C:\\Users\\me\\My Project");
    }

    #[test]
    fn windows_drops_a_trailing_separator_that_would_break_quoting() {
        let list = build_windows_args("C:\\Users\\me\\My Project\\", COMMAND).unwrap();
        assert_eq!(list[1].args[4], "C:\\Users\\me\\My Project");
        let list = build_windows_args("C:/Users/me/My Project//", COMMAND).unwrap();
        assert_eq!(list[1].args[4], "C:\\Users\\me\\My Project");
        // A drive root keeps its backslash: `C:` alone means "the current folder on C".
        let list = build_windows_args("C:\\", COMMAND).unwrap();
        assert_eq!(list[1].args[4], "C:\\");
    }

    #[test]
    fn windows_refuses_a_cmd_special_character_in_the_path() {
        // Both launchers end in `cmd /k claude`, so both need text `cmd` reads as plain.
        for special in ['&', '|', '<', '>', '^', '%', '"', '!', ';', ',', '='] {
            let path = format!("C:\\Users\\me\\R{special}D wiki");
            let message = build_windows_args(&path, COMMAND).unwrap_err();
            assert!(
                message.contains("must not have"),
                "path with {special:?}: {message}"
            );
        }
    }

    #[test]
    fn windows_refuses_a_cmd_special_character_in_the_command() {
        for special in ['&', '|', '<', '>', '^', '%', '"', '!', ';', ',', '='] {
            let command = format!("/wiki-fuse a{special}b");
            let message = build_windows_args("C:\\wiki", &command).unwrap_err();
            assert!(
                message.contains("must not have"),
                "command with {special:?}: {message}"
            );
        }
    }

    #[test]
    fn windows_refuses_a_unc_path_for_both_launchers() {
        for unc in [
            "\\\\server\\share\\wiki",
            "//server/share/wiki",
            "\\/server/share/wiki",
            "/\\server\\share\\wiki",
            "\\\\?\\C:\\wiki",
        ] {
            let message = build_windows_args(unc, COMMAND).unwrap_err();
            assert!(message.contains("UNC"), "{unc}: {message}");
        }
        // A drive path and a root-relative path are not UNC paths.
        assert!(build_windows_args("C:\\wiki", COMMAND).is_ok());
        assert!(build_windows_args("\\wiki", COMMAND).is_ok());
    }

    #[test]
    fn windows_keeps_parentheses_in_program_files_paths() {
        let list = build_windows_args("C:\\Program Files (x86)\\wiki", COMMAND).unwrap();
        assert_eq!(programs(&list), vec!["wt", "cmd"]);
    }

    // ---- Linux ----

    #[test]
    fn linux_candidates_are_in_the_review_focus_order() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        assert_eq!(
            programs(&list),
            vec!["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
        );
        assert!(list.iter().all(|launch| !launch.wait));
    }

    #[test]
    fn linux_gnome_terminal_and_konsole_take_the_folder_and_an_argument_list() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        assert_eq!(
            list[1].args,
            vec![
                "--working-directory=/Users/me/My Project".to_string(),
                "--".to_string(),
                "claude".to_string(),
                COMMAND.to_string(),
            ]
        );
        assert_eq!(
            list[2].args,
            vec![
                "--workdir".to_string(),
                "/Users/me/My Project".to_string(),
                "-e".to_string(),
                "claude".to_string(),
                COMMAND.to_string(),
            ]
        );
    }

    #[test]
    fn linux_gnome_terminal_and_konsole_keep_a_hostile_command_as_one_item() {
        let hostile = "/wiki-fuse it's \"x\" $HOME `id` $(id)";
        let list = linux_candidates(HOSTILE_PATH, hostile).unwrap();
        assert_eq!(
            list[1].args,
            vec![
                format!("--working-directory={HOSTILE_PATH}"),
                "--".to_string(),
                "claude".to_string(),
                hostile.to_string(),
            ]
        );
        assert_eq!(
            list[2].args,
            vec![
                "--workdir".to_string(),
                HOSTILE_PATH.to_string(),
                "-e".to_string(),
                "claude".to_string(),
                hostile.to_string(),
            ]
        );
    }

    #[test]
    fn linux_x_terminal_emulator_and_xterm_run_a_fixed_script_with_arguments() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        for index in [0, 3] {
            let args = &list[index].args;
            assert_eq!(args[0], "-e");
            assert_eq!(args[1], "sh");
            assert_eq!(args[2], "-c");
            assert!(args[3].contains("exec claude \"$2\""), "{}", args[3]);
            assert_eq!(args[4], "sh");
            assert_eq!(args[5], PATH);
            assert_eq!(args[6], COMMAND);
            assert_eq!(args.len(), 7);
        }
    }

    #[test]
    fn linux_text_never_goes_into_a_shell_script() {
        let list = linux_candidates(HOSTILE_PATH, COMMAND).unwrap();
        for launch in &list {
            // The path and the command are whole list items, never part of a script.
            let whole_path = launch
                .args
                .iter()
                .any(|arg| arg == HOSTILE_PATH || arg.ends_with(HOSTILE_PATH));
            assert!(whole_path, "{}: {:?}", launch.program, launch.args);
            for arg in &launch.args {
                if arg.contains("exec claude") {
                    assert!(!arg.contains("mine"), "script has the path: {arg}");
                    assert!(!arg.contains("wiki-fuse"), "script has the command: {arg}");
                }
            }
            assert!(launch.args.iter().any(|arg| arg == COMMAND));
        }
    }

    #[cfg(unix)]
    #[test]
    fn linux_script_runs_claude_in_the_folder_with_the_command_as_one_argument() {
        let base =
            std::env::temp_dir().join(format!("terminal-launch-script-{}", std::process::id()));
        let bin = base.join("bin");
        let folder = base.join("it's \"mine\" $HOME `id`");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&folder).unwrap();
        // A stand-in for `claude` that prints its folder and each argument.
        let fake = bin.join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\npwd -P\nfor a in \"$@\"; do printf '<%s>\\n' \"$a\"; done\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path = folder.to_string_lossy().to_string();
        let command = "/wiki-fuse it's \"x\" $HOME `id`";
        let list = linux_candidates(&path, command).unwrap();
        // Drop the leading `-e`: the terminal removes it before it runs the rest.
        let run = &list[0].args[1..];
        let output = Command::new(run[0].as_str())
            .args(&run[1..])
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let printed = String::from_utf8_lossy(&output.stdout).to_string();
        let expected_folder = std::fs::canonicalize(&folder)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(printed, format!("{expected_folder}\n<{command}>\n"));

        // Without `claude` on PATH the script explains and does not run anything.
        let missing = Command::new(run[0].as_str())
            .args(&run[1..])
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&base);
        let text = String::from_utf8_lossy(&missing.stdout).to_string();
        assert!(text.contains("Could not start Claude Code in"), "{text}");
    }

    // ---- first launcher that starts ----

    #[test]
    fn launch_first_returns_the_name_of_the_first_launcher_that_starts() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        let mut tried = Vec::new();
        let used = launch_first(&list, |launch| {
            tried.push(launch.program);
            if launch.program == "konsole" {
                Ok(())
            } else {
                Err("not found".to_string())
            }
        })
        .unwrap();
        assert_eq!(used, "konsole");
        assert_eq!(
            tried,
            vec!["x-terminal-emulator", "gnome-terminal", "konsole"]
        );
    }

    #[test]
    fn launch_first_returns_an_error_that_names_every_launcher_when_none_starts() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        let message = launch_first(&list, |_| Err("not found".to_string())).unwrap_err();
        for name in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            assert!(message.contains(name), "{message}");
        }
        assert!(message.contains("Copy the command"), "{message}");
    }

    #[test]
    fn launch_first_stops_after_the_first_success() {
        let list = linux_candidates(PATH, COMMAND).unwrap();
        let mut calls = 0;
        let used = launch_first(&list, |_| {
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(used, "x-terminal-emulator");
        assert_eq!(calls, 1);
    }

    // ---- starting a program (a stand-in program, never a real terminal) ----

    #[test]
    fn run_launch_says_not_found_for_a_missing_program() {
        let launch = Launch {
            program: "terminal-launch-no-such-program",
            args: vec![],
            wait: false,
        };
        assert_eq!(run_launch(&launch).unwrap_err(), "not found");
    }

    #[cfg(unix)]
    #[test]
    fn run_launch_starts_a_program_without_waiting_for_it() {
        let marker =
            std::env::temp_dir().join(format!("terminal-launch-ran-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let launch = Launch {
            program: "sh",
            args: vec![
                "-c".to_string(),
                "echo \"$1\" > \"$2\"".to_string(),
                "sh".to_string(),
                "ran".to_string(),
                marker.to_string_lossy().to_string(),
            ],
            wait: false,
        };
        run_launch(&launch).unwrap();
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let text = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        assert_eq!(text.trim(), "ran");
    }

    #[cfg(unix)]
    #[test]
    fn run_launch_reports_the_error_text_of_a_launcher_that_fails() {
        let launch = Launch {
            program: "sh",
            args: vec![
                "-c".to_string(),
                "echo 'not authorized' >&2; exit 3".to_string(),
            ],
            wait: true,
        };
        let message = run_launch(&launch).unwrap_err();
        assert!(message.contains("not authorized"), "{message}");
        let ok = Launch {
            program: "sh",
            args: vec!["-c".to_string(), "exit 0".to_string()],
            wait: true,
        };
        assert!(run_launch(&ok).is_ok());
    }

    // ---- the command itself (these never start a terminal) ----

    #[test]
    fn open_claude_terminal_refuses_a_newline_before_it_looks_at_the_disk() {
        let message = open_claude_terminal(PATH.to_string(), "/wiki-fuse x\nrm -rf ~".to_string())
            .unwrap_err();
        assert!(message.contains("control character"), "{message}");
    }

    #[test]
    fn open_claude_terminal_refuses_a_folder_that_does_not_exist() {
        let message = open_claude_terminal(
            "/definitely/not/a/folder/terminal-launch".to_string(),
            "/wiki-lint".to_string(),
        )
        .unwrap_err();
        assert!(message.contains("folder"), "{message}");
    }
}
