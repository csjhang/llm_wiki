//! Git-backed version history for wiki projects.
//!
//! Every successful ingest becomes one commit that holds only the paths that
//! ingest wrote, and a failed or cancelled ingest restores only those paths to
//! the last commit. These commands shell out to the user's `git`; none of them
//! ever writes to the user's git config.
//!
//! Every command that writes (init, commit, restore) holds the project's git
//! lock, `.llm-wiki/git.lock`, so it never overlaps with `wiki-undo` or
//! `wiki-tool` working on the same project.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Lines `git_init` guarantees in the project's `.gitignore`. `.llm-wiki/`
/// holds secrets and caches and must never be committed.
const REQUIRED_GITIGNORE_LINES: [&str; 3] = [
    ".llm-wiki/",
    ".obsidian/workspace*.json",
    "agent-workspace/",
];
const LLM_WIKI_IGNORE_LINE: &str = ".llm-wiki/";
/// Top-level folders `git_commit_paths` refuses: secrets/caches and git itself.
const NEVER_COMMITTED_TOP_LEVEL_DIRS: [&str; 2] = [".llm-wiki", ".git"];
/// The only top-level folder `git_restore_paths` touches.
const RESTORABLE_TOP_LEVEL_DIR: &str = "wiki";
const INIT_COMMIT_MESSAGE: &str = "chore: start version history";
const UNTRACK_LLM_WIKI_MESSAGE: &str = "chore: stop tracking .llm-wiki";
const FALLBACK_NAME: &str = "LLM Wiki";
const FALLBACK_EMAIL: &str = "llm-wiki@localhost";
/// The git lock shared with `wiki-undo` and `wiki-tool`: one file, one JSON
/// shape (`pid`, `started_at`, `tool`, `host`, `platform`), one set of wait and
/// stale rules.
/// `tools/wiki-tool/src/git-lock.ts` and `undo.mjs` carry the same constants.
const LOCK_FOLDER: &str = ".llm-wiki";
const LOCK_FILE: &str = "git.lock";
const LOCK_TOOL: &str = "app";
const LOCK_BUSY_MESSAGE: &str = "another wiki tool is using git";
const LOCK_WAIT: Duration = Duration::from_secs(30);
const LOCK_POLL: Duration = Duration::from_millis(200);
/// A lock older than this is left over from a crashed tool.
const LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
/// Candidates tried after `git` on PATH: desktop apps often do not inherit the
/// user's login-shell PATH.
const GIT_FALLBACK_PATHS: [&str; 3] = [
    "/usr/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub available: bool,
    pub is_repo: bool,
    /// The project folder is the top of its repository (not nested in a bigger one).
    pub is_root: bool,
    /// The top folder of the repository the project is in, as git prints it.
    /// `None` outside a repository.
    pub top_level: Option<String>,
}

impl GitInfo {
    fn unavailable() -> Self {
        GitInfo {
            available: false,
            is_repo: false,
            is_root: false,
            top_level: None,
        }
    }
}

struct GitOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl GitOutput {
    /// git's own message for a failed run: stderr, or stdout when stderr is empty.
    fn failure_message(&self, args: &[&str]) -> String {
        let stderr = self.stderr.trim();
        let message = if stderr.is_empty() {
            self.stdout.trim()
        } else {
            stderr
        };
        if message.is_empty() {
            format!("git {} failed (exit {:?})", args.join(" "), self.code)
        } else {
            message.to_string()
        }
    }
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn runs_version(candidate: &Path) -> bool {
    let mut cmd = Command::new(candidate);
    suppress_windows_console(&mut cmd);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Find a runnable git binary: `git` on PATH first, then well-known install
/// locations. Only a hit is cached, so installing git later is picked up.
fn resolve_git() -> Option<PathBuf> {
    static CACHE: Mutex<Option<PathBuf>> = Mutex::new(None);
    if let Ok(cache) = CACHE.lock() {
        if let Some(found) = cache.as_ref() {
            return Some(found.clone());
        }
    }
    let found = std::iter::once(PathBuf::from("git"))
        .chain(
            GIT_FALLBACK_PATHS
                .iter()
                .map(PathBuf::from)
                .filter(|candidate| candidate.is_file()),
        )
        .find(|candidate| runs_version(candidate))?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(found.clone());
    }
    Some(found)
}

/// Run `git -C <project_path> <args...>` with extra environment variables and,
/// when given, `input` on stdin. `LC_ALL=C` keeps git's messages stable so they
/// can be matched.
fn run_git_with_input(
    project_path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<GitOutput, String> {
    let git = resolve_git().ok_or_else(|| "git is not installed or not runnable".to_string())?;
    let mut cmd = Command::new(git);
    suppress_windows_console(&mut cmd);
    cmd.arg("-C")
        .arg(project_path)
        .args(args)
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to run git: {error}"))?;
    if let Some(bytes) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(bytes)
                .map_err(|error| format!("Failed to write to git: {error}"))?;
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to run git: {error}"))?;
    Ok(GitOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn run_git_with_env(
    project_path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<GitOutput, String> {
    run_git_with_input(project_path, args, envs, None)
}

fn run_git(project_path: &str, args: &[&str]) -> Result<GitOutput, String> {
    run_git_with_env(project_path, args, &[])
}

/// Run git and map a non-zero exit to `Err(stderr)`.
fn run_git_ok(
    project_path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<GitOutput, String> {
    let output = run_git_with_env(project_path, args, envs)?;
    if output.success {
        Ok(output)
    } else {
        Err(output.failure_message(args))
    }
}

/// Run `git <prefix...> -- <paths...>` and fail like `run_git_ok`.
fn run_git_paths_ok(
    project_path: &str,
    prefix: &[&str],
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<GitOutput, String> {
    let mut args: Vec<&str> = prefix.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    run_git_ok(project_path, &args, envs)
}

/// Split NUL-separated git output (`-z`) into its entries.
fn nul_entries(output: &str) -> Vec<String> {
    output
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(String::from)
        .collect()
}

// ── the shared git lock ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct GitLockOptions {
    /// How long to wait for another tool to let go.
    wait: Duration,
    /// How often to look again while waiting.
    poll: Duration,
    /// The age after which a lock is taken to be left over.
    stale: Duration,
}

impl Default for GitLockOptions {
    fn default() -> Self {
        GitLockOptions {
            wait: LOCK_WAIT,
            poll: LOCK_POLL,
            stale: LOCK_STALE_AFTER,
        }
    }
}

#[cfg(test)]
thread_local! {
    static LOCK_OPTIONS_FOR_TESTS: std::cell::Cell<Option<GitLockOptions>> =
        const { std::cell::Cell::new(None) };
}

/// Lets a test shorten the 30 s wait for the code running on its own thread.
#[cfg(test)]
fn set_lock_options_for_tests(options: Option<GitLockOptions>) {
    LOCK_OPTIONS_FOR_TESTS.with(|cell| cell.set(options));
}

fn lock_options() -> GitLockOptions {
    #[cfg(test)]
    if let Some(options) = LOCK_OPTIONS_FOR_TESTS.with(|cell| cell.get()) {
        return options;
    }
    GitLockOptions::default()
}

/// The lock this process holds. Dropping it releases the lock.
struct GitLock {
    path: PathBuf,
    content: String,
}

impl Drop for GitLock {
    fn drop(&mut self) {
        // Only remove the file while it is still ours: a lock that went stale
        // under a long stall may belong to another tool by now.
        if read_lock_text(&self.path).as_deref() == Some(self.content.as_str()) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn read_lock_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn lock_content() -> String {
    serde_json::json!({
        "pid": std::process::id(),
        "started_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "tool": LOCK_TOOL,
        "host": this_host(),
        "platform": std::env::consts::OS,
    })
    .to_string()
}

/// The name of this machine, as the other lock writers see it (`os.hostname()` in
/// Node is the same name). A pid says something only on the machine that wrote
/// it. Empty when the name cannot be found: then no lock is judged by its pid.
fn this_host() -> &'static str {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(read_host_name)
}

fn read_host_name() -> String {
    let from_file = ["/proc/sys/kernel/hostname", "/etc/hostname"]
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .map(|text| text.trim().to_string())
        .find(|name| !name.is_empty());
    if let Some(name) = from_file {
        return name;
    }
    let from_env = ["HOSTNAME", "COMPUTERNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|name| name.trim().to_string())
        .find(|name| !name.is_empty());
    if let Some(name) = from_env {
        return name;
    }
    let mut command = Command::new("hostname");
    suppress_windows_console(&mut command);
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

/// How long ago the holder took the lock: by its `started_at`, or by the time
/// of the file when the text has no start time that parses (a lock that is
/// being written has no text yet). `None` when the file is gone.
fn lock_age(path: &Path, text: &str) -> Option<Duration> {
    let started_at = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|json| json.get("started_at")?.as_str().map(String::from))
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok());
    if let Some(started_at) = started_at {
        // A start time in the future (clock skew) counts as just started.
        return Some(
            (Utc::now() - started_at.with_timezone(&Utc))
                .to_std()
                .unwrap_or(Duration::ZERO),
        );
    }
    let modified = fs::metadata(path).and_then(|meta| meta.modified()).ok()?;
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or(Duration::ZERO),
    )
}

/// Whether the process with this pid is not running on this machine. Only
/// Linux can say (through `/proc`); elsewhere the answer is "unknown", which
/// counts as running. A pid is meaningful only on the machine and in the
/// process namespace that wrote it.
#[cfg(target_os = "linux")]
fn process_is_gone(pid: u64) -> bool {
    // Without a mounted /proc nothing can be said about any pid.
    pid >= 1
        && Path::new("/proc/self").exists()
        && !Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(not(target_os = "linux"))]
fn process_is_gone(_pid: u64) -> bool {
    false
}

/// True when the lock names a process that is not running. A lock without a
/// usable pid says nothing. A pid is meaningful only on the machine and the
/// platform that wrote it, so a lock whose `host` and `platform` are not this
/// process's own (or are missing) says nothing either: only its age counts.
fn holder_is_gone(text: &str) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let host = json.get("host").and_then(serde_json::Value::as_str);
    let platform = json.get("platform").and_then(serde_json::Value::as_str);
    let here = !this_host().is_empty()
        && host == Some(this_host())
        && platform == Some(std::env::consts::OS);
    here && json
        .get("pid")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(process_is_gone)
}

/// Remove the lock only if it still holds `judged`, the text that was judged
/// stale. Another tool may have replaced the stale lock with its own since the
/// judgment, and that new lock must stay. Returns true when the caller should
/// try to take the lock again right away: the lock was removed, is gone, or was
/// replaced.
fn remove_lock_if_unchanged(path: &Path, judged: &str) -> bool {
    match read_lock_text(path) {
        None => return !path.exists(),
        Some(current) if current != judged => return true,
        Some(_) => {}
    }
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Remove the lock when it is stale: older than `stale_after`, or held by a
/// process that is gone. Returns true when the caller should try to take the
/// lock again right away.
fn clear_stale_lock(path: &Path, stale_after: Duration) -> bool {
    let Some(text) = read_lock_text(path) else {
        return !path.exists();
    };
    let Some(age) = lock_age(path, &text) else {
        return true;
    };
    if age <= stale_after && !holder_is_gone(&text) {
        return false;
    }
    remove_lock_if_unchanged(path, &text)
}

/// `create_new` found the lock taken. On Windows a lock that is being deleted
/// reports "access denied" instead, which also means "try again".
fn lock_is_taken(error: &std::io::Error, path: &Path) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
        || (cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied && path.exists())
}

/// Take `<project>/.llm-wiki/git.lock`, waiting up to `options.wait` for
/// another tool to let go. A lock older than `options.stale` is removed.
fn acquire_git_lock(project_path: &str, options: &GitLockOptions) -> Result<GitLock, String> {
    if !Path::new(project_path).is_dir() {
        return Err(format!("Project folder not found: {project_path}"));
    }
    let folder = Path::new(project_path).join(LOCK_FOLDER);
    fs::create_dir_all(&folder)
        .map_err(|error| format!("Failed to create {LOCK_FOLDER}/: {error}"))?;
    let path = folder.join(LOCK_FILE);
    let deadline = Instant::now() + options.wait;
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let content = lock_content();
                if let Err(error) = file.write_all(content.as_bytes()) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err(format!("Failed to write the git lock: {error}"));
                }
                return Ok(GitLock { path, content });
            }
            Err(error) if lock_is_taken(&error, &path) => {}
            Err(error) => return Err(format!("Failed to take the git lock: {error}")),
        }
        if clear_stale_lock(&path, options.stale) {
            continue;
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(LOCK_BUSY_MESSAGE.to_string());
        }
        std::thread::sleep(options.poll.min(deadline - now));
    }
}

/// Run a git write while holding the project's git lock. The lock is released
/// when `work` returns, fails, or panics.
fn with_git_lock<T>(
    project_path: &str,
    work: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _lock = acquire_git_lock(project_path, &lock_options())?;
    work()
}

fn git_info_inner(project_path: &str) -> GitInfo {
    if resolve_git().is_none() {
        return GitInfo::unavailable();
    }
    let is_repo = run_git(project_path, &["rev-parse", "--is-inside-work-tree"])
        .map(|output| output.success && output.stdout.trim() == "true")
        .unwrap_or(false);
    let top_level = if is_repo {
        show_top_level(project_path)
    } else {
        None
    };
    let is_root = match &top_level {
        Some(top) => same_folder(top, project_path),
        None => false,
    };
    GitInfo {
        available: true,
        is_repo,
        is_root,
        top_level,
    }
}

/// The work tree's top-level folder as `git rev-parse --show-toplevel` prints it.
fn show_top_level(project_path: &str) -> Option<String> {
    let output = run_git(project_path, &["rev-parse", "--show-toplevel"]).ok()?;
    if !output.success {
        return None;
    }
    let top_level = output.stdout.trim();
    if top_level.is_empty() {
        None
    } else {
        Some(top_level.to_string())
    }
}

/// Both sides are canonicalised so symlinks and `\\?\` prefixes compare equal.
fn same_folder(a: &str, b: &str) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Append every line of `lines` that `.gitignore` does not already have,
/// leaving existing lines untouched. Creates the file when it is missing.
fn ensure_gitignore_lines(project_path: &str, lines: &[&str]) -> Result<(), String> {
    let path = Path::new(project_path).join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Failed to read .gitignore: {error}")),
    };
    let missing: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|wanted| !existing.lines().any(|line| line.trim() == *wanted))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    for line in missing {
        updated.push_str(line);
        updated.push('\n');
    }
    fs::write(&path, updated).map_err(|error| format!("Failed to write .gitignore: {error}"))
}

fn git_init_with_env(project_path: &str, envs: &[(&str, &str)]) -> Result<(), String> {
    if git_info_inner(project_path).is_repo {
        return Err("This folder is already inside a git repository".to_string());
    }
    let git_dir = Path::new(project_path).join(".git");
    let git_dir_existed = git_dir.exists();
    run_git_ok(project_path, &["init"], envs)?;
    let baseline = ensure_gitignore_lines(project_path, &REQUIRED_GITIGNORE_LINES)
        .and_then(|()| git_commit_all_with_env(project_path, INIT_COMMIT_MESSAGE, envs));
    if let Err(error) = baseline {
        // Do not leave a half-initialised repo that a retry would refuse as
        // "already a repository". Only remove what this call created.
        if !git_dir_existed {
            let _ = fs::remove_dir_all(&git_dir);
        }
        return Err(error);
    }
    Ok(())
}

fn git_init_inner(project_path: &str) -> Result<(), String> {
    with_git_lock(project_path, || git_init_with_env(project_path, &[]))
}

/// `.llm-wiki/` must never be committed: make sure git ignores it, appending
/// the line to `.gitignore` when it does not.
fn ensure_llm_wiki_ignored(project_path: &str, envs: &[(&str, &str)]) -> Result<(), String> {
    let args = ["check-ignore", "-q", ".llm-wiki/probe"];
    let output = run_git_with_env(project_path, &args, envs)?;
    match output.code {
        Some(0) => Ok(()),
        Some(1) => ensure_gitignore_lines(project_path, &[LLM_WIKI_IGNORE_LINE]),
        _ => Err(output.failure_message(&args)),
    }
}

fn has_head(project_path: &str, envs: &[(&str, &str)]) -> Result<bool, String> {
    Ok(run_git_with_env(project_path, &["rev-parse", "--verify", "-q", "HEAD"], envs)?.success)
}

fn head_sha(project_path: &str, envs: &[(&str, &str)]) -> Result<String, String> {
    Ok(run_git_ok(project_path, &["rev-parse", "HEAD"], envs)?
        .stdout
        .trim()
        .to_string())
}

/// Commit with the flags every app-made commit uses: no hooks, no signing,
/// and the fallback identity for whatever part the user has not configured.
/// `global` goes before `commit` (for example `--literal-pathspecs`); a
/// non-empty `paths` makes the commit path-limited. Returns the new HEAD.
fn commit_as_app(
    project_path: &str,
    message: &str,
    global: &[&str],
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    // Signing and hooks are the user's own commit habits; an automated history
    // commit must not depend on a gpg agent or on a hook that may refuse it.
    let mut args: Vec<String> = vec!["-c".to_string(), "commit.gpgsign=false".to_string()];
    if !has_config(project_path, "user.name", envs)? {
        args.push("-c".to_string());
        args.push(format!("user.name={FALLBACK_NAME}"));
    }
    if !has_config(project_path, "user.email", envs)? {
        args.push("-c".to_string());
        args.push(format!("user.email={FALLBACK_EMAIL}"));
    }
    args.extend(global.iter().map(|arg| arg.to_string()));
    args.extend(["commit", "--no-verify", "--quiet", "-m", message].map(String::from));
    if !paths.is_empty() {
        args.push("--".to_string());
        args.extend(paths.iter().cloned());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(project_path, &arg_refs, envs)?;
    head_sha(project_path, envs)
}

/// The operation git is in the middle of, judged by the files it leaves in the
/// git dir.
fn operation_in_progress(git_dir: &Path) -> Option<&'static str> {
    const MARKERS: [(&str, &str); 6] = [
        ("MERGE_HEAD", "merge"),
        ("REBASE_HEAD", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ];
    MARKERS
        .iter()
        .find(|(marker, _)| git_dir.join(marker).exists())
        .map(|(_, operation)| *operation)
}

/// The file name of the temporary index of the untracking commit. Two projects
/// in one repository share a git dir, so the name comes from a hash of the
/// canonical project path and never collides.
fn untrack_index_name(project_path: &str) -> String {
    let canonical = fs::canonicalize(project_path).unwrap_or_else(|_| PathBuf::from(project_path));
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hash: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("llm-wiki-untrack-{hash}.index")
}

/// Ignoring `.llm-wiki/` does not untrack files an older commit recorded, and
/// a path-limited commit takes such a file's current content from disk, so it
/// would keep committing the secret. When HEAD has `.llm-wiki` files, record
/// their removal as its own `chore: stop tracking .llm-wiki` commit, built in a
/// temporary index from HEAD so it holds nothing else: no staged change of the
/// user and nothing outside a nested project folder. Then drop the files from
/// the real index (they stay on disk). Returns true when it made that commit.
/// While a merge, rebase, cherry-pick, or revert is in progress it refuses to
/// make that commit: a commit made then would end or move that operation. The temporary
/// index is named after a hash of the project path, so two projects in one
/// repository never share it.
fn untrack_llm_wiki(project_path: &str, envs: &[(&str, &str)]) -> Result<bool, String> {
    let in_index = !run_git_ok(project_path, &["ls-files", "--", ".llm-wiki"], envs)?
        .stdout
        .trim()
        .is_empty();
    let in_head = has_head(project_path, envs)?
        && !run_git_ok(
            project_path,
            &["ls-tree", "-r", "--name-only", "HEAD", "--", ".llm-wiki"],
            envs,
        )?
        .stdout
        .trim()
        .is_empty();

    let git_dir = if in_head {
        let git_dir = run_git_ok(project_path, &["rev-parse", "--absolute-git-dir"], envs)?
            .stdout
            .trim()
            .to_string();
        // A commit made now would join the operation instead of standing
        // alone: in a merge it becomes the merge commit, in a rebase or a
        // cherry-pick it moves the sequence along. Leave it to the user.
        // (Dropping the files from the index alone makes no commit.)
        if let Some(operation) = operation_in_progress(Path::new(&git_dir)) {
            return Err(format!(
                "Cannot stop tracking .llm-wiki while a {operation} is in progress. \
                 Finish or abort it, then try again."
            ));
        }
        git_dir
    } else {
        String::new()
    };

    if in_head {
        let temp_index = Path::new(&git_dir).join(untrack_index_name(project_path));
        let temp_index_str = temp_index.to_string_lossy().to_string();
        let mut temp_envs: Vec<(&str, &str)> = envs.to_vec();
        temp_envs.push(("GIT_INDEX_FILE", temp_index_str.as_str()));
        let committed = run_git_ok(project_path, &["read-tree", "HEAD"], &temp_envs)
            .and_then(|_| {
                run_git_ok(
                    project_path,
                    &["rm", "-r", "--cached", "-f", "-q", "--", ".llm-wiki"],
                    &temp_envs,
                )
            })
            .and_then(|_| {
                commit_as_app(project_path, UNTRACK_LLM_WIKI_MESSAGE, &[], &[], &temp_envs)
            });
        let _ = fs::remove_file(&temp_index);
        committed?;
    }
    if in_index {
        // `-f`: with `--cached` it only touches the index, and it lets git drop
        // a staged copy that differs from both HEAD and the file on disk.
        run_git_ok(
            project_path,
            &[
                "rm",
                "-r",
                "--cached",
                "-f",
                "-q",
                "--ignore-unmatch",
                "--",
                ".llm-wiki",
            ],
            envs,
        )?;
    }
    Ok(in_head)
}

/// The new HEAD when `moved`, else `None`: what a commit call returns when it
/// had nothing of its own to commit.
fn head_if(
    moved: bool,
    project_path: &str,
    envs: &[(&str, &str)],
) -> Result<Option<String>, String> {
    if moved {
        head_sha(project_path, envs).map(Some)
    } else {
        Ok(None)
    }
}

fn git_commit_all_with_env(
    project_path: &str,
    message: &str,
    envs: &[(&str, &str)],
) -> Result<Option<String>, String> {
    ensure_llm_wiki_ignored(project_path, envs)?;
    let untracked = untrack_llm_wiki(project_path, envs)?;
    run_git_ok(project_path, &["add", "-A", "--", "."], envs)?;

    let diff_args = ["diff", "--cached", "--quiet", "--", "."];
    let diff = run_git_with_env(project_path, &diff_args, envs)?;
    match diff.code {
        Some(0) => return head_if(untracked, project_path, envs),
        Some(1) => {}
        _ => return Err(diff.failure_message(&diff_args)),
    }

    // Path-limited: keeps staged changes outside a nested project folder out.
    commit_as_app(project_path, message, &[], &[".".to_string()], envs).map(Some)
}

/// True when `git config <key>` prints a non-empty value.
fn has_config(project_path: &str, key: &str, envs: &[(&str, &str)]) -> Result<bool, String> {
    let output = run_git_with_env(project_path, &["config", key], envs)?;
    Ok(output.success && !output.stdout.trim().is_empty())
}

fn git_commit_all_inner(project_path: &str, message: &str) -> Result<Option<String>, String> {
    with_git_lock(project_path, || {
        git_commit_all_with_env(project_path, message, &[])
    })
}

/// A checked project-relative path, rebuilt with `/` separators.
#[derive(Debug, Clone)]
struct ProjectPath {
    /// The path without a trailing `/`, for example `wiki/media/s`.
    rel: String,
    /// The caller named a folder (the path ended in `/`).
    is_dir: bool,
}

/// Check one project-relative path: not empty, not absolute, no `..`, no
/// leading `:` (git pathspec magic such as `:(top)`), and not the project
/// itself. Both `/` and `\\` count as separators so the check holds on every
/// platform; `.` and empty segments are dropped.
fn parse_project_path(raw: &str) -> Result<(ProjectPath, Vec<String>), String> {
    let invalid = || format!("Invalid path: {raw:?}");
    if raw.trim().is_empty() {
        return Err(invalid());
    }
    let looks_absolute = raw.starts_with('/')
        || raw.starts_with('\\')
        || Path::new(raw).is_absolute()
        || raw.as_bytes().get(1) == Some(&b':');
    if looks_absolute || raw.starts_with(':') {
        return Err(invalid());
    }
    let segments: Vec<String> = raw
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .map(String::from)
        .collect();
    if segments.is_empty() || segments.iter().any(|segment| segment == "..") {
        return Err(invalid());
    }
    let path = ProjectPath {
        rel: segments.join("/"),
        is_dir: raw.ends_with('/') || raw.ends_with('\\'),
    };
    Ok((path, segments))
}

/// Paths `git_restore_paths` accepts: inside `wiki/`, never `wiki/` itself.
fn parse_restore_paths(paths: &[String]) -> Result<Vec<ProjectPath>, String> {
    paths
        .iter()
        .map(|raw| {
            let (path, segments) = parse_project_path(raw)?;
            if segments.len() < 2 || segments[0] != RESTORABLE_TOP_LEVEL_DIR {
                return Err(format!(
                    "Refusing to restore {raw:?}: only paths inside wiki/ are restored"
                ));
            }
            Ok(path)
        })
        .collect()
}

/// Paths `git_commit_paths` accepts: anything in the project except
/// `.llm-wiki/` and `.git/`.
fn parse_commit_paths(paths: &[String]) -> Result<Vec<ProjectPath>, String> {
    paths
        .iter()
        .map(|raw| {
            let (path, segments) = parse_project_path(raw)?;
            if NEVER_COMMITTED_TOP_LEVEL_DIRS
                .iter()
                .any(|never| segments[0].eq_ignore_ascii_case(never))
            {
                return Err(format!(
                    "Refusing to commit {raw:?}: {} is never committed",
                    segments[0]
                ));
            }
            Ok(path)
        })
        .collect()
}

fn rels(paths: &[ProjectPath]) -> Vec<String> {
    paths.iter().map(|path| path.rel.clone()).collect()
}

/// Whether one of `entries` (paths relative to the project, as git prints
/// them) is `path` or, for a folder, lies inside it.
fn covers(path: &ProjectPath, entries: &[String]) -> bool {
    let prefix = format!("{}/", path.rel);
    entries
        .iter()
        .any(|entry| *entry == path.rel || entry.starts_with(&prefix))
}

/// Index entries at or under `paths`, relative to the project folder.
fn index_entries(
    project_path: &str,
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let output = run_git_paths_ok(
        project_path,
        &["--literal-pathspecs", "ls-files", "-z", "--cached"],
        paths,
        envs,
    )?;
    Ok(nul_entries(&output.stdout))
}

/// HEAD entries at or under `paths`, relative to the project folder. Empty
/// before the first commit.
fn head_entries(
    project_path: &str,
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<Vec<String>, String> {
    if paths.is_empty() || !has_head(project_path, envs)? {
        return Ok(Vec::new());
    }
    let output = run_git_paths_ok(
        project_path,
        &[
            "--literal-pathspecs",
            "ls-tree",
            "-r",
            "-z",
            "--name-only",
            "HEAD",
        ],
        paths,
        envs,
    )?;
    Ok(nul_entries(&output.stdout))
}

/// Which of `paths` git ignores (`.gitignore` and friends).
fn ignored_paths(
    project_path: &str,
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    let args = ["check-ignore", "--stdin", "-z"];
    let output = run_git_with_input(project_path, &args, envs, Some(&input))?;
    match output.code {
        // 0: some are ignored; 1: none is.
        Some(0) | Some(1) => Ok(nul_entries(&output.stdout)),
        _ => Err(output.failure_message(&args)),
    }
}

/// Untracked, non-ignored files at or under `paths`, relative to the project
/// folder: what `git add -A` would add there.
fn untracked_entries(
    project_path: &str,
    paths: &[String],
    envs: &[(&str, &str)],
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let output = run_git_paths_ok(
        project_path,
        &[
            "--literal-pathspecs",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
        ],
        paths,
        envs,
    )?;
    Ok(nul_entries(&output.stdout))
}

fn exists_on_disk(project_path: &str, rel: &str) -> bool {
    fs::symlink_metadata(Path::new(project_path).join(rel)).is_ok()
}

/// A real folder on disk (a symlink to one does not count).
fn is_dir_on_disk(project_path: &str, rel: &str) -> bool {
    fs::symlink_metadata(Path::new(project_path).join(rel))
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
}

/// Whether git compares file names without regard to case (`core.ignorecase`,
/// which `git init` sets on macOS and Windows). Unset or unreadable: false.
fn ignores_case(project_path: &str) -> bool {
    run_git(project_path, &["config", "--bool", "core.ignorecase"])
        .map(|output| output.success && output.stdout.trim() == "true")
        .unwrap_or(false)
}

fn git_commit_paths_with_env(
    project_path: &str,
    paths: &[String],
    message: &str,
    envs: &[(&str, &str)],
) -> Result<Option<String>, String> {
    let paths = parse_commit_paths(paths)?;
    ensure_llm_wiki_ignored(project_path, envs)?;
    let untracked = untrack_llm_wiki(project_path, envs)?;

    let all = rels(&paths);
    let in_index = index_entries(project_path, &all, envs)?;
    let in_head = head_entries(project_path, &all, envs)?;
    let known = |path: &ProjectPath| covers(path, &in_index) || covers(path, &in_head);
    // `git add` refuses an ignored path and a path that is neither on disk
    // nor in the index; leave those out instead of failing the commit.
    let new_on_disk: Vec<String> = paths
        .iter()
        .filter(|path| !known(path) && exists_on_disk(project_path, &path.rel))
        .map(|path| path.rel.clone())
        .collect();
    let ignored = ignored_paths(project_path, &new_on_disk, envs)?;
    // `git add` also fails on a new folder that holds nothing it can add (an
    // empty one; one with only ignored files can fail too). Leave it out: git
    // would not record it anyway.
    let new_dirs: Vec<String> = new_on_disk
        .iter()
        .filter(|rel| !ignored.contains(rel) && is_dir_on_disk(project_path, rel))
        .cloned()
        .collect();
    let addable = untracked_entries(project_path, &new_dirs, envs)?;
    let nothing_to_add: Vec<String> = paths
        .iter()
        .filter(|path| new_dirs.contains(&path.rel) && !covers(path, &addable))
        .map(|path| path.rel.clone())
        .collect();
    let to_add: Vec<String> = paths
        .iter()
        .filter(|path| {
            covers(path, &in_index)
                || (exists_on_disk(project_path, &path.rel)
                    && !ignored.contains(&path.rel)
                    && !nothing_to_add.contains(&path.rel))
        })
        .map(|path| path.rel.clone())
        .collect();
    if !to_add.is_empty() {
        run_git_paths_ok(
            project_path,
            &["--literal-pathspecs", "add", "-A"],
            &to_add,
            envs,
        )?;
    }
    // A path only HEAD knows (its deletion is already staged) can still be
    // committed, though `git add` would not take it.
    let to_commit: Vec<String> = paths
        .iter()
        .filter(|path| to_add.contains(&path.rel) || covers(path, &in_head))
        .map(|path| path.rel.clone())
        .collect();
    if to_commit.is_empty() {
        return head_if(untracked, project_path, envs);
    }

    let mut diff_args: Vec<&str> = vec!["--literal-pathspecs", "diff", "--cached", "--quiet", "--"];
    diff_args.extend(to_commit.iter().map(String::as_str));
    let diff = run_git_with_env(project_path, &diff_args, envs)?;
    match diff.code {
        Some(0) => return head_if(untracked, project_path, envs),
        Some(1) => {}
        _ => return Err(diff.failure_message(&diff_args)),
    }

    // Path-limited: staged changes to any other path stay staged, uncommitted.
    commit_as_app(
        project_path,
        message,
        &["--literal-pathspecs"],
        &to_commit,
        envs,
    )
    .map(Some)
}

fn git_commit_paths_inner(
    project_path: &str,
    paths: &[String],
    message: &str,
) -> Result<Option<String>, String> {
    // A bad path is the caller's mistake: report it without waiting for the lock.
    parse_commit_paths(paths)?;
    with_git_lock(project_path, || {
        git_commit_paths_with_env(project_path, paths, message, &[])
    })
}

/// Put `paths` (inside `wiki/`) back as they are in HEAD and touch nothing
/// else. A path HEAD or the index knows is restored from HEAD (index and work
/// tree; a staged new file is removed). A file git does not know is deleted.
/// A folder (a path ending in `/`) gets its known files restored and only its
/// untracked files deleted. Ignored files are never deleted: the baseline
/// commit could not record them, so they may predate the ingest.
fn git_restore_paths_inner(project_path: &str, paths: &[String]) -> Result<(), String> {
    let paths = parse_restore_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    with_git_lock(project_path, || restore_checked_paths(project_path, &paths))
}

fn restore_checked_paths(project_path: &str, paths: &[ProjectPath]) -> Result<(), String> {
    let all = rels(paths);
    let in_index = index_entries(project_path, &all, &[])?;
    let in_head = head_entries(project_path, &all, &[])?;
    let root = Path::new(project_path);

    // Tell the file watcher these changes come from the app, so a deleted
    // page is not handled as an external delete.
    for path in paths {
        crate::commands::file_sync::mark_app_write_path(&root.join(&path.rel));
    }

    let mut known: Vec<String> = paths
        .iter()
        .filter(|path| covers(path, &in_index) || covers(path, &in_head))
        .map(|path| path.rel.clone())
        .collect();
    let mut unknown_files: Vec<String> = paths
        .iter()
        .filter(|path| !path.is_dir && !known.contains(&path.rel))
        .filter(|path| {
            fs::symlink_metadata(root.join(&path.rel))
                .map(|meta| !meta.is_dir())
                .unwrap_or(false)
        })
        .map(|path| path.rel.clone())
        .collect();

    // With `core.ignorecase` git treats `wiki/Foo.md` and `wiki/foo.md` as one
    // file, but a literal pathspec does not match across case. The disk may
    // hold that one file under either name, so a file that matches a tracked
    // entry ignoring case is never deleted: the tracked entry is restored.
    if !unknown_files.is_empty() && ignores_case(project_path) {
        let top = [RESTORABLE_TOP_LEVEL_DIR.to_string()];
        let mut tracked = index_entries(project_path, &top, &[])?;
        tracked.extend(head_entries(project_path, &top, &[])?);
        unknown_files.retain(|rel| {
            let lower = rel.to_lowercase();
            let variants: Vec<&String> = tracked
                .iter()
                .filter(|entry| entry.to_lowercase() == lower)
                .collect();
            for entry in &variants {
                if !known.contains(entry) {
                    known.push((*entry).clone());
                }
            }
            variants.is_empty()
        });
    }

    if !known.is_empty() {
        if !has_head(project_path, &[])? {
            return Err("There is no commit to restore from".to_string());
        }
        run_git_paths_ok(
            project_path,
            &[
                "--literal-pathspecs",
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
            ],
            &known,
            &[],
        )?;
    }

    let ignored = ignored_paths(project_path, &unknown_files, &[])?;
    for rel in unknown_files.iter().filter(|rel| !ignored.contains(rel)) {
        fs::remove_file(root.join(rel))
            .map_err(|error| format!("Failed to delete {rel}: {error}"))?;
    }

    let dirs: Vec<String> = paths
        .iter()
        .filter(|path| path.is_dir && root.join(&path.rel).is_dir())
        .map(|path| path.rel.clone())
        .collect();
    if !dirs.is_empty() {
        // No `-x`: ignored files (such as editor or OS state) are kept.
        run_git_paths_ok(
            project_path,
            &["--literal-pathspecs", "clean", "-f", "-d", "-q"],
            &dirs,
            &[],
        )?;
    }
    Ok(())
}

/// The full sha of HEAD, or `None` before the first commit.
fn git_head_inner(project_path: &str) -> Result<Option<String>, String> {
    run_git_ok(project_path, &["rev-parse", "--git-dir"], &[])?;
    if has_head(project_path, &[])? {
        head_sha(project_path, &[]).map(Some)
    } else {
        Ok(None)
    }
}

/// True for text that can be the sha of a commit: 7 to 64 hex digits. The semantic-lint marker
/// keeps its commit in this shape (`tools/wiki-tool/src/lint/marker.ts`). Anything else could be
/// read by git as an option or a name.
fn is_commit_sha(text: &str) -> bool {
    (7..=64).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The full sha of `sha` when it names a commit that is an ancestor of HEAD (or HEAD itself).
/// `None` when the commit is unknown (the history was rewritten and the object is gone), is
/// ambiguous, or lies on another line of history. `sha` must pass `is_commit_sha`.
fn ancestor_of_head(project_path: &str, sha: &str) -> Result<Option<String>, String> {
    let spec = format!("{sha}^{{commit}}");
    let found = run_git_with_env(
        project_path,
        &["rev-parse", "--verify", "--quiet", &spec],
        &[],
    )?;
    if !found.success {
        return Ok(None);
    }
    let full = found.stdout.trim().to_string();
    let args = ["merge-base", "--is-ancestor", full.as_str(), "HEAD"];
    let check = run_git_with_env(project_path, &args, &[])?;
    match check.code {
        // 0: an ancestor (or HEAD itself). 1: not an ancestor.
        Some(0) => Ok(Some(full)),
        Some(1) => Ok(None),
        _ => Err(check.failure_message(&args)),
    }
}

/// The commits after `since` (all commits without it) that touch the project folder and whose
/// subject starts with `prefix`. It counts like `ingestsSince` of `wiki-tool lint changed-domains`
/// (`tools/wiki-tool/src/lint/changed-domains.ts`): the pathspec `.` is the project folder, so
/// another folder of a larger repository does not count; a `since` that is not an ancestor of
/// HEAD (or not in the repository) counts every such commit; a repository with no commit has none.
/// It only reads, so it takes no lock.
fn git_count_subjects_inner(
    project_path: &str,
    since: Option<&str>,
    prefix: &str,
) -> Result<u32, String> {
    if prefix.is_empty() {
        return Err("the subject prefix must not be empty".to_string());
    }
    let since = match since {
        Some(sha) if is_commit_sha(sha) => Some(sha.to_ascii_lowercase()),
        Some(_) => return Err("since must be a commit sha of 7 to 64 hex digits".to_string()),
        None => None,
    };
    run_git_ok(project_path, &["rev-parse", "--git-dir"], &[])?;
    if !has_head(project_path, &[])? {
        return Ok(0);
    }
    let base = match since {
        Some(sha) => ancestor_of_head(project_path, &sha)?,
        None => None,
    };
    let range = match base {
        Some(sha) => format!("{sha}..HEAD"),
        None => "HEAD".to_string(),
    };
    let log = run_git_ok(
        project_path,
        &[
            "--literal-pathspecs",
            "log",
            "--format=%s",
            &range,
            "--",
            ".",
        ],
        &[],
    )?;
    let count = log
        .stdout
        .lines()
        .filter(|subject| subject.starts_with(prefix))
        .count();
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

async fn run_blocking<T, F>(label: &str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("{label} task failed: {error}"))?
}

#[tauri::command]
pub async fn git_info(project_path: String) -> GitInfo {
    tauri::async_runtime::spawn_blocking(move || git_info_inner(&project_path))
        .await
        .unwrap_or_else(|_| GitInfo::unavailable())
}

#[tauri::command]
pub async fn git_init(project_path: String) -> Result<(), String> {
    run_blocking("Git init", move || git_init_inner(&project_path)).await
}

#[tauri::command]
pub async fn git_commit_all(
    project_path: String,
    message: String,
) -> Result<Option<String>, String> {
    run_blocking("Git commit", move || {
        git_commit_all_inner(&project_path, &message)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_paths(
    project_path: String,
    paths: Vec<String>,
    message: String,
) -> Result<Option<String>, String> {
    run_blocking("Git commit", move || {
        git_commit_paths_inner(&project_path, &paths, &message)
    })
    .await
}

#[tauri::command]
pub async fn git_restore_paths(project_path: String, paths: Vec<String>) -> Result<(), String> {
    run_blocking("Git restore", move || {
        git_restore_paths_inner(&project_path, &paths)
    })
    .await
}

#[tauri::command]
pub async fn git_head(project_path: String) -> Result<Option<String>, String> {
    run_blocking("Git head", move || git_head_inner(&project_path)).await
}

#[tauri::command]
pub async fn git_count_subjects(
    project_path: String,
    since: Option<String>,
    prefix: String,
) -> Result<u32, String> {
    run_blocking("Git count", move || {
        git_count_subjects_inner(&project_path, since.as_deref(), &prefix)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llm-wiki-git-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn path_str(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    /// Run git directly (not through the module under test) and return stdout.
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git must be installed to run these tests");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn init_repo_with_identity(dir: &Path) {
        git(dir, &["init"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let file = dir.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, contents).unwrap();
    }

    fn is_sha(value: &str) -> bool {
        value.len() == 40 && value.chars().all(|c| c.is_ascii_hexdigit())
    }

    #[test]
    fn info_reports_non_repo() {
        let dir = temp_dir();
        let info = git_info_inner(&path_str(&dir));
        assert!(info.available);
        assert!(!info.is_repo);
        assert!(!info.is_root);
    }

    #[test]
    fn info_reports_repo() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        let info = git_info_inner(&path_str(&dir));
        assert!(info.available);
        assert!(info.is_repo);
        assert!(info.is_root);
    }

    #[test]
    fn info_reports_a_project_nested_in_another_repo_as_not_root() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        fs::create_dir_all(&project).unwrap();
        let info = git_info_inner(&path_str(&project));
        assert!(info.available);
        assert!(info.is_repo);
        assert!(!info.is_root);
    }

    #[test]
    fn info_serializes_is_root_as_camel_case() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        let json = serde_json::to_value(git_info_inner(&path_str(&dir))).unwrap();
        assert_eq!(json["isRoot"], serde_json::Value::Bool(true));
        assert_eq!(json["isRepo"], serde_json::Value::Bool(true));
        assert!(json["topLevel"].is_string(), "json: {json}");
    }

    #[test]
    fn info_names_the_enclosing_repository_of_a_nested_project() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        fs::create_dir_all(&project).unwrap();

        let top_level = git_info_inner(&path_str(&project))
            .top_level
            .expect("a nested project names its repository");

        assert_eq!(
            fs::canonicalize(top_level).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
    }

    #[test]
    fn info_has_no_top_level_outside_a_repo() {
        let info = git_info_inner(&path_str(&temp_dir()));
        assert_eq!(info.top_level, None);
        let json = serde_json::to_value(info).unwrap();
        assert!(json["topLevel"].is_null(), "json: {json}");
    }

    #[test]
    fn init_writes_gitignore_and_first_commit() {
        let dir = temp_dir();
        write(&dir, ".llm-wiki/secret", "api-key");
        write(&dir, "wiki/a.md", "# A");

        git_init_inner(&path_str(&dir)).unwrap();

        let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(
            ignore,
            ".llm-wiki/\n.obsidian/workspace*.json\nagent-workspace/\n"
        );
        let log = git(&dir, &["log", "--oneline"]);
        assert_eq!(log.lines().count(), 1);
        assert!(log.contains("chore: start version history"));
        let tracked = git(&dir, &["ls-files"]);
        assert!(!tracked.contains(".llm-wiki"));
        assert!(tracked.contains("wiki/a.md"));
    }

    #[test]
    fn init_appends_missing_lines_to_existing_gitignore() {
        let dir = temp_dir();
        write(&dir, ".gitignore", "node_modules/\n*.log");

        git_init_inner(&path_str(&dir)).unwrap();

        let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(
            ignore,
            "node_modules/\n*.log\n.llm-wiki/\n.obsidian/workspace*.json\nagent-workspace/\n"
        );
    }

    #[test]
    fn init_does_not_duplicate_lines_already_present() {
        let dir = temp_dir();
        write(&dir, ".gitignore", ".llm-wiki/\nagent-workspace/\n");

        git_init_inner(&path_str(&dir)).unwrap();

        let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(
            ignore,
            ".llm-wiki/\nagent-workspace/\n.obsidian/workspace*.json\n"
        );
    }

    #[test]
    fn init_rejects_existing_repo() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        let err = git_init_inner(&path_str(&dir)).unwrap_err();
        assert!(err.contains("already"), "unexpected error: {err}");
    }

    #[test]
    fn commit_all_returns_none_when_clean() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "wiki/a.md", "# A");
        assert!(git_commit_all_inner(&path_str(&dir), "first")
            .unwrap()
            .is_some());

        let result = git_commit_all_inner(&path_str(&dir), "second").unwrap();
        assert_eq!(result, None);
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
    }

    #[test]
    fn commit_all_commits_changes() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, "wiki/a.md", "# A");

        let sha = git_commit_all_inner(&path_str(&dir), "ingest: A (1 pages)\n\n- wiki/a.md")
            .unwrap()
            .expect("a commit sha");

        assert!(is_sha(&sha), "not a full sha: {sha}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]).trim(), sha);
        assert!(git(&dir, &["show", "--stat", "--format=%B", "HEAD"]).contains("wiki/a.md"));
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s"]).trim(),
            "ingest: A (1 pages)"
        );
    }

    #[test]
    fn commit_all_records_deletions() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, "wiki/a.md", "# A");
        write(&dir, "wiki/b.md", "# B");
        git_commit_all_inner(&path_str(&dir), "first").unwrap();

        fs::remove_file(dir.join("wiki/b.md")).unwrap();
        let sha = git_commit_all_inner(&path_str(&dir), "second").unwrap();

        assert!(sha.is_some());
        assert!(!git(&dir, &["ls-files"]).contains("wiki/b.md"));
    }

    #[test]
    fn commit_all_uses_fallback_identity() {
        let dir = temp_dir();
        // Plain `git init` with no identity anywhere.
        git(&dir, &["init"]);
        write(&dir, "wiki/a.md", "# A");
        let empty_home = temp_dir();
        let home = path_str(&empty_home);

        let sha = git_commit_all_with_env(
            &path_str(&dir),
            "ingest: A (1 pages)",
            &[
                ("HOME", home.as_str()),
                ("USERPROFILE", home.as_str()),
                ("XDG_CONFIG_HOME", home.as_str()),
                ("GIT_CONFIG_NOSYSTEM", "1"),
            ],
        )
        .unwrap();

        assert!(sha.is_some());
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%an <%ae>"]).trim(),
            "LLM Wiki <llm-wiki@localhost>"
        );
    }

    #[test]
    fn commit_all_keeps_a_configured_identity() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, "wiki/a.md", "# A");

        git_commit_all_inner(&path_str(&dir), "first").unwrap();

        assert_eq!(
            git(&dir, &["log", "-1", "--format=%an <%ae>"]).trim(),
            "Test <test@example.com>"
        );
    }

    #[test]
    fn commit_all_stays_inside_a_nested_project_folder() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/seed.md", "seed");
        git_commit_all_inner(&path_str(&project), "chore: start").unwrap();

        write(&root, "other.txt", "outside the project");
        write(&project, "wiki/a.md", "# A");
        let sha = git_commit_all_inner(&path_str(&project), "ingest: A (1 pages)").unwrap();

        assert!(sha.is_some());
        let files = git(&root, &["show", "--name-only", "--format=", "HEAD"]);
        assert_eq!(files.trim(), "wiki-p/wiki/a.md");
        assert!(git(&root, &["status", "--porcelain"]).contains("other.txt"));
    }

    #[test]
    fn commit_all_never_commits_llm_wiki_even_when_gitignore_lacks_it() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", "node_modules/\n");
        write(&dir, ".llm-wiki/secret", "api-key");
        write(&dir, "wiki/a.md", "# A");

        git_commit_all_inner(&path_str(&dir), "first").unwrap();

        let tracked = git(&dir, &["ls-files"]);
        assert!(!tracked.contains(".llm-wiki"), "tracked: {tracked}");
        assert!(tracked.contains("wiki/a.md"));
        let ignore = fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(ignore, "node_modules/\n.llm-wiki/\n");
    }

    #[test]
    fn commit_all_never_commits_llm_wiki_without_any_gitignore() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".llm-wiki/secret", "api-key");
        write(&dir, "wiki/a.md", "# A");

        git_commit_all_inner(&path_str(&dir), "first").unwrap();

        let tracked = git(&dir, &["ls-files"]);
        assert!(!tracked.contains(".llm-wiki"), "tracked: {tracked}");
        assert_eq!(
            fs::read_to_string(dir.join(".gitignore")).unwrap(),
            ".llm-wiki/\n"
        );
    }

    #[test]
    fn commit_all_errors_outside_a_repo() {
        let dir = temp_dir();
        write(&dir, "wiki/a.md", "# A");
        assert!(git_commit_all_inner(&path_str(&dir), "first").is_err());
    }

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    /// The files changed by `HEAD`, one per line, sorted.
    fn head_files(dir: &Path) -> Vec<String> {
        let mut files: Vec<String> = git(dir, &["show", "--name-only", "--format=", "HEAD"])
            .lines()
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect();
        files.sort();
        files
    }

    fn read(dir: &Path, rel: &str) -> String {
        fs::read_to_string(dir.join(rel)).unwrap()
    }

    /// A repo whose last commit holds `.gitignore`, `wiki/a.md` and `wiki/b.md`.
    fn repo_with_committed_wiki() -> PathBuf {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "wiki/a.md", "a committed");
        write(&dir, "wiki/b.md", "b committed");
        git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();
        dir
    }

    // ── git_restore_paths ────────────────────────────────────────────────

    #[test]
    fn restore_paths_restores_only_the_files_of_the_failed_run() {
        let dir = repo_with_committed_wiki();
        // The failing run edits a tracked page and creates a new one.
        write(&dir, "wiki/a.md", "a edited by the failed run");
        write(&dir, "wiki/concepts/new.md", "new page of the failed run");
        // Another feature writes during the run.
        write(&dir, "wiki/queries/r.md", "research page");
        write(&dir, "wiki/b.md", "b edited by another feature");

        git_restore_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md", "wiki/concepts/new.md"]),
        )
        .unwrap();

        assert_eq!(read(&dir, "wiki/a.md"), "a committed");
        assert!(!dir.join("wiki/concepts/new.md").exists());
        assert_eq!(read(&dir, "wiki/queries/r.md"), "research page");
        assert_eq!(read(&dir, "wiki/b.md"), "b edited by another feature");
    }

    #[test]
    fn restore_paths_brings_back_a_deleted_tracked_file() {
        let dir = repo_with_committed_wiki();
        fs::remove_file(dir.join("wiki/a.md")).unwrap();

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/a.md"])).unwrap();

        assert_eq!(read(&dir, "wiki/a.md"), "a committed");
    }

    #[test]
    fn restore_paths_unstages_staged_changes() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "staged change");
        write(&dir, "wiki/new.md", "staged new file");
        git(&dir, &["add", "-A"]);

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/a.md", "wiki/new.md"])).unwrap();

        assert_eq!(read(&dir, "wiki/a.md"), "a committed");
        assert!(!dir.join("wiki/new.md").exists());
        assert_eq!(git(&dir, &["status", "--porcelain"]).trim(), "");
    }

    #[test]
    fn restore_paths_restores_a_folder_and_deletes_only_its_untracked_files() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/media/s/1.png", "one");
        write(&dir, "wiki/media/other/x.png", "x");
        git_commit_all_inner(&path_str(&dir), "chore: media").unwrap();
        write(&dir, "wiki/media/s/1.png", "one changed");
        write(&dir, "wiki/media/s/2.png", "two");
        write(&dir, "wiki/media/s/deep/3.png", "three");
        write(&dir, "wiki/media/other/y.png", "y");
        write(
            &dir,
            "wiki/media/s-2/z.png",
            "a folder whose name starts the same",
        );

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/media/s/"])).unwrap();

        assert_eq!(read(&dir, "wiki/media/s/1.png"), "one");
        assert!(!dir.join("wiki/media/s/2.png").exists());
        assert!(!dir.join("wiki/media/s/deep").exists());
        assert!(dir.join("wiki/media/other/y.png").exists());
        assert!(dir.join("wiki/media/s-2/z.png").exists());
    }

    #[test]
    fn restore_paths_removes_a_folder_that_only_the_run_created() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/media/new/1.png", "one");

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/media/new/"])).unwrap();

        assert!(!dir.join("wiki/media/new").exists());
        assert!(dir.join("wiki/a.md").exists());
    }

    #[test]
    fn restore_paths_accepts_paths_that_do_not_exist() {
        let dir = repo_with_committed_wiki();
        git_restore_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/never-written.md", "wiki/media/none/"]),
        )
        .unwrap();
        assert_eq!(git(&dir, &["status", "--porcelain"]).trim(), "");
    }

    /// A repo whose HEAD holds `wiki/foo.md`; the page is then edited and a
    /// file `wiki/Foo.md` that differs only in case is created next to it. On a
    /// case-sensitive disk these are two files; with `core.ignorecase=true`
    /// git treats them as one, as it does on macOS and Windows.
    fn repo_with_a_case_variant(ignore_case: bool) -> PathBuf {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "wiki/foo.md", "foo committed");
        git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();
        git(
            &dir,
            &[
                "config",
                "core.ignorecase",
                if ignore_case { "true" } else { "false" },
            ],
        );
        write(&dir, "wiki/foo.md", "foo edited");
        write(&dir, "wiki/Foo.md", "the written path");
        dir
    }

    #[test]
    fn restore_paths_keeps_a_case_variant_of_a_tracked_file_when_git_ignores_case() {
        let dir = repo_with_a_case_variant(true);

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/Foo.md"])).unwrap();

        assert!(dir.join("wiki/Foo.md").exists());
        assert_eq!(read(&dir, "wiki/foo.md"), "foo committed");
    }

    #[test]
    fn restore_paths_keeps_a_tracked_file_in_a_case_variant_folder_when_git_ignores_case() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "wiki/concepts/x.md", "x committed");
        git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();
        git(&dir, &["config", "core.ignorecase", "true"]);
        write(&dir, "wiki/concepts/x.md", "x edited");
        write(&dir, "wiki/Concepts/X.md", "the written path");

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/Concepts/X.md"])).unwrap();

        assert!(dir.join("wiki/Concepts/X.md").exists());
        assert_eq!(read(&dir, "wiki/concepts/x.md"), "x committed");
    }

    #[test]
    fn restore_paths_deletes_an_unknown_file_when_git_respects_case() {
        let dir = repo_with_a_case_variant(false);

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/Foo.md"])).unwrap();

        assert!(!dir.join("wiki/Foo.md").exists());
        assert_eq!(read(&dir, "wiki/foo.md"), "foo edited");
    }

    #[test]
    fn restore_paths_keeps_ignored_files() {
        let dir = repo_with_committed_wiki();
        write(&dir, ".gitignore", ".llm-wiki/\nwiki/private/\n*.tmp\n");
        git_commit_all_inner(&path_str(&dir), "chore: ignore").unwrap();
        write(
            &dir,
            "wiki/private/notes.md",
            "the user's own ignored notes",
        );
        write(&dir, "wiki/media/s/cache.tmp", "ignored");
        write(&dir, "wiki/media/s/1.png", "untracked");

        git_restore_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/private/notes.md", "wiki/media/s/"]),
        )
        .unwrap();

        assert_eq!(
            read(&dir, "wiki/private/notes.md"),
            "the user's own ignored notes"
        );
        assert!(dir.join("wiki/media/s/cache.tmp").exists());
        assert!(!dir.join("wiki/media/s/1.png").exists());
    }

    #[test]
    fn restore_paths_never_touches_raw_or_llm_wiki() {
        let dir = repo_with_committed_wiki();
        write(&dir, "raw/sources/new.md", "new source");
        write(&dir, ".llm-wiki/cache.json", "{}");
        write(&dir, "wiki/new.md", "new file");

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/new.md"])).unwrap();

        assert!(dir.join("raw/sources/new.md").exists());
        assert!(dir.join(".llm-wiki/cache.json").exists());
        assert!(!dir.join("wiki/new.md").exists());
    }

    #[test]
    fn restore_paths_rejects_paths_outside_wiki() {
        let dir = repo_with_committed_wiki();
        write(&dir, "raw/sources/s.md", "source committed");
        git_commit_all_inner(&path_str(&dir), "chore: raw").unwrap();
        write(&dir, "raw/sources/s.md", "source edited");
        write(&dir, "wiki/a.md", "a edited");
        let p = path_str(&dir);

        for bad in [
            "",
            ".",
            "./",
            "wiki",
            "wiki/",
            "./wiki",
            "wiki/.",
            "WIKI/a.md",
            "raw",
            "raw/sources/s.md",
            ".llm-wiki/cache.json",
            ".gitignore",
            "../x",
            "/abs",
            "C:\\abs",
            "\\abs",
            ":(top)wiki/a.md",
            "wiki/../raw/sources/s.md",
            "wiki\\..\\raw\\sources\\s.md",
        ] {
            assert!(
                git_restore_paths_inner(&p, &strings(&[bad])).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
        // One bad path rejects the whole call before anything changes.
        assert!(git_restore_paths_inner(&p, &strings(&["wiki/a.md", "raw/sources/s.md"])).is_err());

        assert_eq!(read(&dir, "raw/sources/s.md"), "source edited");
        assert_eq!(read(&dir, "wiki/a.md"), "a edited");
    }

    #[cfg(unix)]
    #[test]
    fn restore_paths_reads_paths_literally() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited");
        write(&dir, "wiki/*.md", "a page whose name is a glob");

        git_restore_paths_inner(&path_str(&dir), &strings(&["wiki/*.md"])).unwrap();

        assert!(!dir.join("wiki/*.md").exists());
        assert_eq!(read(&dir, "wiki/a.md"), "a edited");
    }

    #[test]
    fn restore_paths_stays_inside_a_nested_project_folder() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/a.md", "committed text");
        write(&root, "wiki/a.md", "outer");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "seed"]);
        write(&project, "wiki/a.md", "changed");
        write(&root, "wiki/a.md", "outer changed");

        git_restore_paths_inner(&path_str(&project), &strings(&["wiki/a.md"])).unwrap();

        assert_eq!(read(&project, "wiki/a.md"), "committed text");
        assert_eq!(read(&root, "wiki/a.md"), "outer changed");
    }

    #[test]
    fn restore_paths_tells_the_file_watcher_that_the_app_changed_them() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited");
        write(&dir, "wiki/new.md", "new");
        write(&dir, "wiki/media/s/1.png", "one");

        git_restore_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md", "wiki/new.md", "wiki/media/s/"]),
        )
        .unwrap();

        use crate::commands::file_sync::is_app_write_ignored;
        assert!(is_app_write_ignored(&dir.join("wiki/a.md")));
        assert!(is_app_write_ignored(&dir.join("wiki/new.md")));
        assert!(is_app_write_ignored(&dir.join("wiki/media/s/1.png")));
        assert!(!is_app_write_ignored(&dir.join("wiki/b.md")));
    }

    // ── git_commit_paths ─────────────────────────────────────────────────

    #[test]
    fn commit_paths_commits_only_the_given_paths() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited by the ingest");
        write(&dir, "wiki/concepts/new.md", "new page of the ingest");
        // A research page written by another feature during the run.
        write(&dir, "wiki/queries/r.md", "research page");

        let sha = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md", "wiki/concepts/new.md"]),
            "ingest: A (2 pages)\n\n- wiki/a.md\n- wiki/concepts/new.md",
        )
        .unwrap()
        .expect("a commit sha");

        assert!(is_sha(&sha), "not a full sha: {sha}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]).trim(), sha);
        assert_eq!(head_files(&dir), vec!["wiki/a.md", "wiki/concepts/new.md"]);
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s"]).trim(),
            "ingest: A (2 pages)"
        );
        assert!(git(&dir, &["status", "--porcelain"]).contains("?? wiki/queries/"));

        // The next baseline records the research page.
        git_commit_all_inner(&path_str(&dir), "chore: save changes before ingest").unwrap();
        assert_eq!(head_files(&dir), vec!["wiki/queries/r.md"]);
    }

    #[test]
    fn commit_paths_records_a_deleted_path() {
        let dir = repo_with_committed_wiki();
        fs::remove_file(dir.join("wiki/a.md")).unwrap();

        let sha = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap();

        assert!(sha.is_some());
        assert!(!git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains("wiki/a.md"));
    }

    #[test]
    fn commit_paths_returns_none_when_its_paths_did_not_change() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/b.md", "b edited by someone else");

        let result = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap();

        assert_eq!(result, None);
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
        assert!(git(&dir, &["status", "--porcelain"]).contains("wiki/b.md"));
    }

    #[test]
    fn commit_paths_skips_missing_and_ignored_paths() {
        let dir = repo_with_committed_wiki();
        write(&dir, ".gitignore", ".llm-wiki/\nraw/assets/\n");
        git_commit_all_inner(&path_str(&dir), "chore: ignore").unwrap();
        write(&dir, "wiki/new.md", "new page");
        write(&dir, "raw/assets/big.bin", "ignored");

        let sha = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&[
                "wiki/new.md",
                "raw/parsed/never-written.pdf.md",
                "raw/assets/big.bin",
                "raw/assets/",
                "wiki/media/none/",
                ".gitignore",
            ]),
            "ingest: New (1 pages)",
        )
        .unwrap();

        assert!(sha.is_some());
        assert_eq!(head_files(&dir), vec!["wiki/new.md"]);
    }

    #[test]
    fn commit_paths_skips_an_empty_new_folder() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited by the ingest");
        // The run created its media folder but wrote no image into it.
        fs::create_dir_all(dir.join("wiki/media/x")).unwrap();

        let sha = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md", "wiki/media/x/"]),
            "ingest: A (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert!(is_sha(&sha), "not a full sha: {sha}");
        assert_eq!(head_files(&dir), vec!["wiki/a.md"]);
    }

    #[test]
    fn commit_paths_skips_a_new_folder_with_only_ignored_files() {
        let dir = repo_with_committed_wiki();
        write(&dir, ".gitignore", ".llm-wiki/\n*.tmp\n");
        git_commit_all_inner(&path_str(&dir), "chore: ignore tmp").unwrap();
        write(&dir, "wiki/media/y/z.tmp", "ignored");
        let head_before = git(&dir, &["rev-parse", "HEAD"]);

        let result = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/media/y/"]),
            "ingest: Y (0 pages)",
        )
        .unwrap();

        assert_eq!(result, None);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head_before);
    }

    #[test]
    fn commit_paths_commits_a_new_folder_given_without_a_trailing_slash() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/media/s/1.png", "one");
        fs::create_dir_all(dir.join("wiki/media/empty")).unwrap();

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/media/s", "wiki/media/empty"]),
            "ingest: S (0 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(head_files(&dir), vec!["wiki/media/s/1.png"]);
    }

    #[test]
    fn commit_paths_commits_a_folder() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/media/s/1.png", "one");
        write(&dir, "wiki/media/s/deep/2.png", "two");
        write(
            &dir,
            "wiki/media/s-2/x.png",
            "a folder whose name starts the same",
        );

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/media/s/"]),
            "ingest: S (0 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(
            head_files(&dir),
            vec!["wiki/media/s/1.png", "wiki/media/s/deep/2.png"]
        );
    }

    #[test]
    fn commit_paths_leaves_other_staged_changes_staged() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/b.md", "staged by the user");
        git(&dir, &["add", "wiki/b.md"]);
        write(&dir, "wiki/a.md", "a edited by the ingest");

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(head_files(&dir), vec!["wiki/a.md"]);
        assert_eq!(
            git(&dir, &["diff", "--cached", "--name-only"]).trim(),
            "wiki/b.md"
        );
    }

    #[cfg(unix)]
    #[test]
    fn commit_paths_reads_paths_literally() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited");
        write(&dir, "wiki/*.md", "a page whose name is a glob");

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/*.md"]),
            "ingest: G (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(head_files(&dir), vec!["wiki/*.md"]);
        assert!(git(&dir, &["status", "--porcelain"]).contains("wiki/a.md"));
    }

    #[test]
    fn commit_paths_rejects_unsafe_paths() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited");
        let p = path_str(&dir);
        for bad in [
            "",
            ".",
            "./",
            "../x",
            "/abs",
            "C:\\abs",
            "\\abs",
            ":(top)wiki/a.md",
            "wiki/../../x",
            ".llm-wiki",
            ".llm-wiki/secret",
            "./.llm-wiki/secret",
            ".LLM-WIKI/secret",
            ".git/config",
        ] {
            assert!(
                git_commit_paths_inner(&p, &strings(&["wiki/a.md", bad]), "ingest: A (1 pages)")
                    .is_err(),
                "expected {bad:?} to be rejected"
            );
        }
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
    }

    #[test]
    fn commit_paths_never_commits_llm_wiki_even_when_gitignore_lacks_it() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".llm-wiki/secret", "api-key");
        write(&dir, "wiki/a.md", "# A");

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md", ".gitignore"]),
            "ingest: A (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        let tracked = git(&dir, &["ls-files"]);
        assert!(!tracked.contains(".llm-wiki"), "tracked: {tracked}");
        assert_eq!(head_files(&dir), vec![".gitignore", "wiki/a.md"]);
        assert_eq!(read(&dir, ".gitignore"), ".llm-wiki/\n");
    }

    #[test]
    fn commit_paths_stops_tracking_llm_wiki_in_its_own_commit() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-f", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        write(&dir, ".llm-wiki/secret", "v2 changed since");
        write(&dir, "wiki/b.md", "staged by the user");
        git(&dir, &["add", "wiki/b.md"]);
        write(&dir, "wiki/a.md", "# A changed by the ingest");

        git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s", "HEAD"]).trim(),
            "ingest: A (1 pages)"
        );
        assert_eq!(head_files(&dir), vec!["wiki/a.md"]);
        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s", "HEAD~1"]).trim(),
            "chore: stop tracking .llm-wiki"
        );
        assert_eq!(
            git(&dir, &["show", "--name-status", "--format=", "HEAD~1"]).trim(),
            "D\t.llm-wiki/secret"
        );
        assert_eq!(git(&dir, &["ls-files", ".llm-wiki"]).trim(), "");
        assert_eq!(read(&dir, ".llm-wiki/secret"), "v2 changed since");
        assert_eq!(
            git(&dir, &["diff", "--cached", "--name-only"]).trim(),
            "wiki/b.md"
        );
    }

    #[test]
    fn commit_paths_stays_inside_a_nested_project_folder() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/seed.md", "seed");
        git_commit_all_inner(&path_str(&project), "chore: start").unwrap();
        write(&root, "other.txt", "outside the project");
        write(&project, "wiki/a.md", "# A");

        git_commit_paths_inner(
            &path_str(&project),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(head_files(&root), vec!["wiki-p/wiki/a.md"]);
        assert!(git(&root, &["status", "--porcelain"]).contains("other.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn commit_paths_ignores_gpgsign_and_failing_pre_commit_hook() {
        let dir = repo_with_committed_wiki();
        git(&dir, &["config", "commit.gpgsign", "true"]);
        git(&dir, &["config", "gpg.format", "openpgp"]);
        git(&dir, &["config", "gpg.program", "false"]);
        write_failing_pre_commit_hook(&dir);
        write(&dir, "wiki/a.md", "# A changed");

        let sha = git_commit_paths_inner(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
        )
        .unwrap();

        assert!(sha.is_some());
    }

    #[test]
    fn commit_paths_uses_fallback_identity() {
        let dir = temp_dir();
        git(&dir, &["init"]);
        write(&dir, "wiki/a.md", "# A");
        let empty_home = temp_dir();
        let home = path_str(&empty_home);

        git_commit_paths_with_env(
            &path_str(&dir),
            &strings(&["wiki/a.md"]),
            "ingest: A (1 pages)",
            &[
                ("HOME", home.as_str()),
                ("USERPROFILE", home.as_str()),
                ("XDG_CONFIG_HOME", home.as_str()),
                ("GIT_CONFIG_NOSYSTEM", "1"),
            ],
        )
        .unwrap()
        .expect("a commit");

        assert_eq!(
            git(&dir, &["log", "-1", "--format=%an <%ae>"]).trim(),
            "LLM Wiki <llm-wiki@localhost>"
        );
    }

    // ── .llm-wiki untracking (git_commit_all) ────────────────────────────

    #[test]
    fn commit_all_stops_tracking_llm_wiki_in_its_own_commit() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        write(&dir, "wiki/a.md", "# A changed");

        git_commit_all_inner(&path_str(&dir), "chore: save changes before ingest")
            .unwrap()
            .expect("a commit");

        assert_eq!(
            git(&dir, &["log", "-1", "--format=%s", "HEAD~1"]).trim(),
            "chore: stop tracking .llm-wiki"
        );
        assert_eq!(
            git(&dir, &["show", "--name-status", "--format=", "HEAD~1"]).trim(),
            "D\t.llm-wiki/secret"
        );
        let last = head_files(&dir);
        assert!(
            !last.iter().any(|f| f.starts_with(".llm-wiki")),
            "last commit: {last:?}"
        );
        assert!(last.contains(&"wiki/a.md".to_string()));
    }

    #[test]
    fn commit_all_untracks_llm_wiki_when_its_staged_copy_was_edited_again() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-f", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        // Staged content differs from both HEAD and the file on disk:
        // `git rm --cached` without `-f` refuses this.
        write(&dir, ".llm-wiki/secret", "v2 staged");
        git(&dir, &["add", "-f", ".llm-wiki/secret"]);
        write(&dir, ".llm-wiki/secret", "v3 on disk");

        let sha =
            git_commit_all_inner(&path_str(&dir), "chore: save changes before ingest").unwrap();

        assert!(sha.is_some());
        assert_eq!(git(&dir, &["ls-files", ".llm-wiki"]).trim(), "");
        assert!(!git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains(".llm-wiki/"));
        assert_eq!(read(&dir, ".llm-wiki/secret"), "v3 on disk");
    }

    // ── git_head ─────────────────────────────────────────────────────────

    #[test]
    fn head_is_none_before_the_first_commit_and_the_sha_after() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        assert_eq!(git_head_inner(&path_str(&dir)).unwrap(), None);

        write(&dir, "wiki/a.md", "# A");
        let sha = git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();

        assert_eq!(git_head_inner(&path_str(&dir)).unwrap(), sha);
    }

    #[test]
    fn head_errors_outside_a_repo() {
        assert!(git_head_inner(&path_str(&temp_dir())).is_err());
    }

    #[cfg(unix)]
    fn write_failing_pre_commit_hook(repo: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let hook = repo.join(".git/hooks/pre-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn commit_all_ignores_gpgsign_and_failing_pre_commit_hook() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        git(&dir, &["config", "commit.gpgsign", "true"]);
        // `false` as the signer always fails (pin the format so a global ssh
        // signing setup cannot take over).
        git(&dir, &["config", "gpg.format", "openpgp"]);
        git(&dir, &["config", "gpg.program", "false"]);
        write_failing_pre_commit_hook(&dir);
        write(&dir, "wiki/a.md", "# A");

        let sha = git_commit_all_inner(&path_str(&dir), "ingest: A (1 pages)").unwrap();

        assert!(sha.is_some());
        assert!(git(&dir, &["ls-files"]).contains("wiki/a.md"));
    }

    #[cfg(unix)]
    #[test]
    fn init_baseline_commit_ignores_gpgsign_and_failing_hook() {
        // A global template with a failing hook and signing on, as a user could have.
        let template = temp_dir();
        let hooks = template.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            let hook = hooks.join("pre-commit");
            fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = temp_dir();
        write(
            &home,
            ".gitconfig",
            &format!(
                "[init]\n\ttemplateDir = {}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n",
                template.display()
            ),
        );
        let dir = temp_dir();
        write(&dir, "wiki/a.md", "# A");
        let home_str = path_str(&home);

        git_init_with_env(
            &path_str(&dir),
            &[
                ("HOME", home_str.as_str()),
                ("USERPROFILE", home_str.as_str()),
                ("XDG_CONFIG_HOME", home_str.as_str()),
                ("GIT_CONFIG_NOSYSTEM", "1"),
            ],
        )
        .unwrap();

        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
    }

    #[test]
    fn commit_all_untracks_an_already_tracked_llm_wiki_folder() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        assert!(git(&dir, &["ls-files", ".llm-wiki"]).contains("secret"));
        write(&dir, ".llm-wiki/secret", "v2 changed since");
        write(&dir, "wiki/a.md", "# A changed");

        let sha = git_commit_all_inner(&path_str(&dir), "ingest: A (1 pages)").unwrap();

        assert!(sha.is_some());
        assert_eq!(git(&dir, &["ls-files", ".llm-wiki"]).trim(), "");
        assert_eq!(
            fs::read_to_string(dir.join(".llm-wiki/secret")).unwrap(),
            "v2 changed since"
        );
        assert_eq!(
            git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"])
                .lines()
                .filter(|l| l.starts_with(".llm-wiki/"))
                .count(),
            0
        );
        assert!(git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains("wiki/a.md"));
        assert_eq!(git(&dir, &["status", "--porcelain"]).trim(), "");
    }

    #[test]
    fn commit_all_untracks_llm_wiki_even_when_it_is_the_only_change() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);

        let sha = git_commit_all_inner(&path_str(&dir), "chore: untrack").unwrap();

        assert!(sha.is_some());
        assert_eq!(git(&dir, &["ls-files", ".llm-wiki"]).trim(), "");
        assert!(dir.join(".llm-wiki/secret").exists());
        assert!(!git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains(".llm-wiki/"));
    }

    /// An index path git cannot write to: every `add` / `commit` fails.
    fn broken_index_env() -> String {
        path_str(&temp_dir().join("missing-dir").join("index"))
    }

    #[test]
    fn init_removes_the_git_folder_it_created_when_the_baseline_commit_fails() {
        let dir = temp_dir();
        write(&dir, "wiki/a.md", "# A");
        let index = broken_index_env();

        let result = git_init_with_env(&path_str(&dir), &[("GIT_INDEX_FILE", index.as_str())]);

        assert!(result.is_err());
        assert!(
            !dir.join(".git").exists(),
            ".git should have been rolled back"
        );
        assert!(!git_info_inner(&path_str(&dir)).is_repo);
        assert!(dir.join("wiki/a.md").exists());
        // A retry now works from scratch.
        git_init_inner(&path_str(&dir)).unwrap();
        assert_eq!(git(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
    }

    #[test]
    fn init_keeps_a_git_folder_that_existed_before_when_the_commit_fails() {
        let dir = temp_dir();
        // An empty `.git` folder is not a repository, so `git_init` proceeds.
        fs::create_dir_all(dir.join(".git")).unwrap();
        write(&dir, "wiki/a.md", "# A");
        let index = broken_index_env();

        let result = git_init_with_env(&path_str(&dir), &[("GIT_INDEX_FILE", index.as_str())]);

        assert!(result.is_err());
        assert!(
            dir.join(".git").exists(),
            "a pre-existing .git must not be removed"
        );
    }

    #[test]
    fn commit_all_commits_a_staged_llm_wiki_removal_instead_of_re_adding_it() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-f", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        // The user already ran `git rm --cached` but has not committed yet.
        git(&dir, &["rm", "-r", "--cached", "-q", ".llm-wiki"]);
        write(&dir, ".llm-wiki/secret", "v2 changed since");

        git_commit_all_inner(&path_str(&dir), "ingest: A (1 pages)").unwrap();

        assert!(!git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains(".llm-wiki/"));
        assert!(dir.join(".llm-wiki/secret").exists());
    }

    #[test]
    fn commit_all_untracks_llm_wiki_without_committing_staged_changes_outside_the_project() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("p");
        write(&project, ".llm-wiki/secret", "v1");
        write(&project, "wiki/a.md", "# A");
        write(&root, "outer/o.md", "outer");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "seed"]);
        write(&project, ".llm-wiki/secret", "v2 changed since");
        write(&root, "outer/o.md", "outer staged by the user");
        git(&root, &["add", "outer/o.md"]);

        git_commit_all_inner(&path_str(&project), "chore: save changes before ingest").unwrap();

        let head_tree = git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(!head_tree.contains("p/.llm-wiki/"), "tree: {head_tree}");
        // The user's staged change outside the project stays staged and uncommitted.
        assert_eq!(git(&root, &["show", "HEAD:outer/o.md"]), "outer");
        assert_eq!(
            git(&root, &["diff", "--cached", "--name-only"]).trim(),
            "outer/o.md"
        );
        assert_eq!(read(&project, ".llm-wiki/secret"), "v2 changed since");
    }

    // ── the shared git lock ──────────────────────────────────────────────

    use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
    use std::time::{Duration, Instant};

    fn lock_path(dir: &Path) -> PathBuf {
        dir.join(".llm-wiki").join("git.lock")
    }

    /// Put a lock file in the shape every tool writes, as another tool would.
    /// The holder is this test process, which is alive.
    fn write_lock(dir: &Path, tool: &str, started_at: DateTime<Utc>) {
        write_lock_of(dir, tool, started_at, std::process::id());
    }

    /// A lock written on this machine and platform, by the process `pid`.
    fn write_lock_of(dir: &Path, tool: &str, started_at: DateTime<Utc>, pid: u32) {
        write_lock_on(
            dir,
            tool,
            started_at,
            pid,
            Some(this_host()),
            Some(std::env::consts::OS),
        );
    }

    /// A lock as another machine or platform (or an older tool, with no host) would write it.
    fn write_lock_on(
        dir: &Path,
        tool: &str,
        started_at: DateTime<Utc>,
        pid: u32,
        host: Option<&str>,
        platform: Option<&str>,
    ) {
        let mut text = serde_json::json!({
            "pid": pid,
            "started_at": started_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "tool": tool,
        });
        if let Some(host) = host {
            text["host"] = serde_json::json!(host);
        }
        if let Some(platform) = platform {
            text["platform"] = serde_json::json!(platform);
        }
        write(dir, ".llm-wiki/git.lock", &text.to_string());
    }

    /// The pid of a process that has already exited.
    fn exited_pid() -> u32 {
        let mut child = Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    /// Run `work` with the lock wait set to `wait_ms`, so a test does not wait 30 s.
    fn with_lock_wait<T>(wait_ms: u64, work: impl FnOnce() -> T) -> T {
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                set_lock_options_for_tests(None);
            }
        }
        set_lock_options_for_tests(Some(GitLockOptions {
            wait: Duration::from_millis(wait_ms),
            ..GitLockOptions::default()
        }));
        let _reset = Reset;
        work()
    }

    /// A repo with one commit and a page edit that is waiting to be committed.
    fn repo_with_a_page_to_commit() -> PathBuf {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "a edited");
        dir
    }

    #[test]
    fn lock_file_holds_pid_start_time_tool_host_and_platform_until_it_is_dropped() {
        let dir = temp_dir();
        let before = Utc::now() - ChronoDuration::seconds(1);

        let lock = acquire_git_lock(&path_str(&dir), &GitLockOptions::default()).unwrap();

        let text = fs::read_to_string(lock_path(&dir)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["pid"], serde_json::json!(std::process::id()));
        assert_eq!(json["tool"], serde_json::json!("app"));
        assert_eq!(json["platform"], serde_json::json!(std::env::consts::OS));
        let host = json["host"].as_str().unwrap();
        assert!(!host.is_empty());
        assert_eq!(host, this_host());
        // The Node tools write os.hostname(). On a Unix system `hostname` prints the same name.
        #[cfg(unix)]
        if let Ok(output) = Command::new("hostname").output() {
            if output.status.success() {
                assert_eq!(host, String::from_utf8_lossy(&output.stdout).trim());
            }
        }
        let started = DateTime::parse_from_rfc3339(json["started_at"].as_str().unwrap()).unwrap();
        assert!(started.with_timezone(&Utc) >= before);
        assert!(json["started_at"].as_str().unwrap().ends_with('Z'));
        drop(lock);
        assert!(!lock_path(&dir).exists());
    }

    #[test]
    fn commit_waits_for_the_lock() {
        let dir = repo_with_a_page_to_commit();
        write_lock(&dir, "wiki-tool", Utc::now());
        let lock = lock_path(&dir);
        let holder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            fs::remove_file(lock).unwrap();
        });

        let started = Instant::now();
        let sha = git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();
        let waited = started.elapsed();
        holder.join().unwrap();

        assert!(sha.is_some());
        assert!(waited >= Duration::from_millis(400), "waited {waited:?}");
        assert!(!lock_path(&dir).exists());
    }

    #[test]
    fn stale_lock_is_replaced() {
        let dir = repo_with_a_page_to_commit();
        write_lock(&dir, "wiki-tool", Utc::now() - ChronoDuration::minutes(11));

        let started = Instant::now();
        let sha = git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();

        assert!(sha.is_some());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!lock_path(&dir).exists());
    }

    #[test]
    fn a_lock_younger_than_ten_minutes_is_not_stale() {
        let dir = repo_with_a_page_to_commit();
        write_lock(&dir, "wiki-tool", Utc::now() - ChronoDuration::minutes(9));

        let result = with_lock_wait(300, || git_commit_all_inner(&path_str(&dir), "x"));

        assert_eq!(result, Err("another wiki tool is using git".to_string()));
        assert!(lock_path(&dir).exists());
    }

    #[test]
    fn a_lock_with_unreadable_text_goes_stale_by_its_file_time() {
        let dir = repo_with_a_page_to_commit();
        write(&dir, ".llm-wiki/git.lock", "not json");
        let file = fs::OpenOptions::new()
            .write(true)
            .open(lock_path(&dir))
            .unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(11 * 60))
            .unwrap();
        drop(file);

        let sha = git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();
        assert!(sha.is_some());

        // A fresh unreadable lock is still a lock.
        write(&dir, ".llm-wiki/git.lock", "not json");
        write(&dir, "wiki/a.md", "a edited again");
        let result = with_lock_wait(300, || git_commit_all_inner(&path_str(&dir), "x"));
        assert_eq!(result, Err("another wiki tool is using git".to_string()));
    }

    // Needs /proc to look a process up; elsewhere the check is skipped.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_lock_whose_process_is_gone_is_replaced_at_once() {
        let dir = repo_with_a_page_to_commit();
        write_lock_of(&dir, "wiki-tool", Utc::now(), exited_pid());

        let started = Instant::now();
        let sha = git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();

        assert!(sha.is_some());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!lock_path(&dir).exists());
    }

    // Needs /proc to look a process up; elsewhere the check is skipped.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_lock_of_a_dead_pid_is_kept_when_it_was_written_elsewhere() {
        let other_host = format!("{}-other", this_host());
        let cases: [(&str, Option<&str>, Option<&str>); 5] = [
            (
                "another host",
                Some(other_host.as_str()),
                Some(std::env::consts::OS),
            ),
            ("another platform", Some(this_host()), Some("windows")),
            ("no host", None, Some(std::env::consts::OS)),
            ("no platform", Some(this_host()), None),
            ("neither", None, None),
        ];
        for (name, host, platform) in cases {
            let dir = repo_with_a_page_to_commit();
            write_lock_on(&dir, "wiki-tool", Utc::now(), exited_pid(), host, platform);

            let result = with_lock_wait(250, || git_commit_all_inner(&path_str(&dir), "x"));

            assert_eq!(
                result,
                Err("another wiki tool is using git".to_string()),
                "{name}"
            );
            assert!(lock_path(&dir).exists(), "{name}");
        }
    }

    #[test]
    fn such_a_lock_is_replaced_once_it_is_older_than_the_stale_limit() {
        let dir = repo_with_a_page_to_commit();
        write_lock_on(
            &dir,
            "wiki-tool",
            Utc::now() - ChronoDuration::minutes(11),
            exited_pid(),
            Some("elsewhere"),
            Some("elsewhere"),
        );

        let sha = git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();

        assert!(sha.is_some());
        assert!(!lock_path(&dir).exists());
    }

    #[test]
    fn a_lock_that_exists_but_cannot_be_read_is_held_not_spun_on() {
        let dir = repo_with_a_page_to_commit();
        // A folder at the place of the lock file: it exists, and reading it fails.
        fs::create_dir_all(lock_path(&dir)).unwrap();

        let started = Instant::now();
        let result = with_lock_wait(300, || git_commit_all_inner(&path_str(&dir), "x"));
        let elapsed = started.elapsed();

        assert_eq!(result, Err("another wiki tool is using git".to_string()));
        assert!(elapsed >= Duration::from_millis(250), "waited {elapsed:?}");
        assert!(elapsed < Duration::from_secs(3), "waited {elapsed:?}");
        assert!(lock_path(&dir).exists());
    }

    #[test]
    fn a_fresh_lock_whose_process_is_alive_is_kept() {
        let dir = repo_with_a_page_to_commit();
        write_lock_of(&dir, "wiki-tool", Utc::now(), std::process::id());

        let result = with_lock_wait(300, || git_commit_all_inner(&path_str(&dir), "x"));

        assert_eq!(result, Err("another wiki tool is using git".to_string()));
        assert!(lock_path(&dir).exists());
    }

    #[test]
    fn a_lock_without_a_usable_pid_is_judged_by_its_age_only() {
        for pid in [
            serde_json::json!(null),
            serde_json::json!(0),
            serde_json::json!(-5),
            serde_json::json!(1.5),
            serde_json::json!("abc"),
        ] {
            let dir = repo_with_a_page_to_commit();
            let text = serde_json::json!({
                "pid": pid,
                "started_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                "tool": "wiki-tool",
            });
            write(&dir, ".llm-wiki/git.lock", &text.to_string());

            let result = with_lock_wait(250, || git_commit_all_inner(&path_str(&dir), "x"));

            assert_eq!(result, Err("another wiki tool is using git".to_string()));
        }
    }

    #[test]
    fn a_stale_lock_is_removed_only_while_it_holds_the_text_that_was_judged() {
        let dir = temp_dir();
        let judged = r#"{"pid":1,"started_at":"2020-01-01T00:00:00.000Z","tool":"app"}"#;
        let newer = r#"{"pid":2,"started_at":"2099-01-01T00:00:00.000Z","tool":"wiki-undo"}"#;

        // Another tool replaced the stale lock after it was judged: leave the new one.
        write(&dir, ".llm-wiki/git.lock", newer);
        assert!(remove_lock_if_unchanged(&lock_path(&dir), judged));
        assert_eq!(read(&dir, ".llm-wiki/git.lock"), newer);

        // Unchanged: removed.
        write(&dir, ".llm-wiki/git.lock", judged);
        assert!(remove_lock_if_unchanged(&lock_path(&dir), judged));
        assert!(!lock_path(&dir).exists());

        // Already gone: nothing to do, try again.
        assert!(remove_lock_if_unchanged(&lock_path(&dir), judged));
    }

    #[test]
    fn every_write_command_fails_with_the_busy_message_while_another_tool_holds_git() {
        let busy = "another wiki tool is using git".to_string();

        // git_init: a folder that is not a repository yet.
        let fresh = temp_dir();
        write(&fresh, "wiki/a.md", "# A");
        write_lock(&fresh, "wiki-tool", Utc::now());
        assert_eq!(
            with_lock_wait(250, || git_init_inner(&path_str(&fresh))).unwrap_err(),
            busy
        );
        assert!(!fresh.join(".git").exists());

        let dir = repo_with_a_page_to_commit();
        let head = git(&dir, &["rev-parse", "HEAD"]);
        write_lock(&dir, "wiki-undo", Utc::now());
        let p = path_str(&dir);

        assert_eq!(
            with_lock_wait(250, || git_commit_all_inner(&p, "x")).unwrap_err(),
            busy
        );
        assert_eq!(
            with_lock_wait(250, || git_commit_paths_inner(
                &p,
                &strings(&["wiki/a.md"]),
                "x"
            ))
            .unwrap_err(),
            busy
        );
        assert_eq!(
            with_lock_wait(250, || git_restore_paths_inner(
                &p,
                &strings(&["wiki/a.md"])
            ))
            .unwrap_err(),
            busy
        );

        // Nothing ran: no commit, the edit is still on disk, and the other tool's lock stands.
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
        assert_eq!(read(&dir, "wiki/a.md"), "a edited");
        assert!(lock_path(&dir).exists());
    }

    #[test]
    fn read_only_commands_do_not_need_the_lock() {
        let dir = repo_with_committed_wiki();
        write_lock(&dir, "wiki-tool", Utc::now());
        let p = path_str(&dir);

        assert!(with_lock_wait(250, || git_info_inner(&p)).is_repo);
        assert!(git_head_inner(&p).unwrap().is_some());
        assert!(lock_path(&dir).exists());
    }

    #[test]
    fn the_lock_is_released_after_every_command_even_when_it_fails() {
        let dir = repo_with_a_page_to_commit();
        let p = path_str(&dir);

        git_commit_all_inner(&p, "ingest: a (1 pages)").unwrap();
        assert!(!lock_path(&dir).exists());

        git_commit_paths_inner(&p, &strings(&["wiki/a.md"]), "x").unwrap();
        assert!(!lock_path(&dir).exists());
        assert!(git_commit_paths_inner(&p, &strings(&[".llm-wiki/x"]), "x").is_err());
        assert!(!lock_path(&dir).exists());

        git_restore_paths_inner(&p, &strings(&["wiki/a.md"])).unwrap();
        assert!(!lock_path(&dir).exists());
        assert!(git_restore_paths_inner(&p, &strings(&["raw/x.md"])).is_err());
        assert!(!lock_path(&dir).exists());

        let fresh = temp_dir();
        write(&fresh, "wiki/a.md", "# A");
        git_init_inner(&path_str(&fresh)).unwrap();
        assert!(!lock_path(&fresh).exists());
        assert!(git_init_inner(&path_str(&fresh)).is_err());
        assert!(!lock_path(&fresh).exists());

        let outside = temp_dir();
        assert!(git_commit_all_inner(&path_str(&outside), "x").is_err());
        assert!(!lock_path(&outside).exists());
    }

    #[test]
    fn the_lock_is_held_while_git_runs() {
        let dir = repo_with_a_page_to_commit();
        // post-commit runs even with --no-verify. It copies the lock while the commit is made.
        let hook = dir.join(".git/hooks/post-commit");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(
            &hook,
            "#!/bin/sh\ncp .llm-wiki/git.lock .git/lock-seen-by-commit\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        }

        git_commit_all_inner(&path_str(&dir), "ingest: a (1 pages)").unwrap();

        if cfg!(unix) {
            let seen: serde_json::Value =
                serde_json::from_str(&read(&dir, ".git/lock-seen-by-commit")).unwrap();
            assert_eq!(seen["tool"], serde_json::json!("app"));
            assert_eq!(seen["pid"], serde_json::json!(std::process::id()));
        }
    }

    #[test]
    fn dropping_a_lock_leaves_a_lock_another_tool_took_over() {
        let dir = temp_dir();
        let lock = acquire_git_lock(&path_str(&dir), &GitLockOptions::default()).unwrap();
        write_lock(&dir, "wiki-undo", Utc::now());

        drop(lock);

        let json: serde_json::Value =
            serde_json::from_str(&read(&dir, ".llm-wiki/git.lock")).unwrap();
        assert_eq!(json["tool"], serde_json::json!("wiki-undo"));
    }

    #[test]
    fn the_lock_works_for_a_project_nested_in_a_larger_repo() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/a.md", "# A");

        git_commit_all_inner(&path_str(&project), "chore: start").unwrap();

        assert!(!lock_path(&project).exists());
        assert!(!lock_path(&root).exists());
        assert!(!git(&root, &["ls-files"]).contains("git.lock"));
    }

    // ── the untracking commit ────────────────────────────────────────────

    /// A repo whose HEAD tracks `.llm-wiki/secret` (an old version committed it),
    /// with a page edit waiting.
    fn repo_that_tracks_llm_wiki() -> PathBuf {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, ".llm-wiki/secret", "v1");
        write(&dir, "wiki/a.md", "# A");
        git(&dir, &["add", "-f", "-A"]);
        git(&dir, &["commit", "-m", "old commit that tracked .llm-wiki"]);
        write(&dir, "wiki/a.md", "# A edited");
        dir
    }

    #[test]
    fn untracking_commit_refuses_during_a_merge() {
        let dir = repo_that_tracks_llm_wiki();
        let main = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .to_string();
        git(&dir, &["checkout", "-q", "-b", "side"]);
        write(&dir, "wiki/b.md", "side");
        git(&dir, &["add", "wiki/b.md"]);
        git(&dir, &["commit", "-q", "-m", "side change"]);
        git(&dir, &["checkout", "-q", &main]);
        git(&dir, &["checkout", "--", "wiki/a.md"]);
        write(&dir, "wiki/b.md", "main");
        git(&dir, &["add", "wiki/b.md"]);
        git(&dir, &["commit", "-q", "-m", "main change"]);
        // A conflicting merge stops half way and leaves MERGE_HEAD.
        let merge = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["merge", "--no-edit", "side"])
            .output()
            .unwrap();
        assert!(!merge.status.success());
        assert!(dir.join(".git/MERGE_HEAD").exists());
        let head = git(&dir, &["rev-parse", "HEAD"]);

        let error = git_commit_all_inner(&path_str(&dir), "chore: save").unwrap_err();

        assert!(
            error.contains("Cannot stop tracking .llm-wiki while a merge is in progress"),
            "unexpected error: {error}"
        );
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
        assert!(
            dir.join(".git/MERGE_HEAD").exists(),
            "the merge must stay in progress"
        );
        assert!(git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains(".llm-wiki/secret"));
        assert!(!lock_path(&dir).exists());
    }

    #[test]
    fn untracking_commit_refuses_during_a_rebase_cherry_pick_or_revert() {
        for (marker, is_folder, word) in [
            ("MERGE_HEAD", false, "merge"),
            ("REBASE_HEAD", false, "rebase"),
            ("CHERRY_PICK_HEAD", false, "cherry-pick"),
            ("REVERT_HEAD", false, "revert"),
            ("rebase-merge", true, "rebase"),
            ("rebase-apply", true, "rebase"),
        ] {
            let dir = repo_that_tracks_llm_wiki();
            let head = git(&dir, &["rev-parse", "HEAD"]);
            if is_folder {
                fs::create_dir_all(dir.join(".git").join(marker)).unwrap();
            } else {
                fs::write(dir.join(".git").join(marker), &head).unwrap();
            }

            let paths_error =
                git_commit_paths_inner(&path_str(&dir), &strings(&["wiki/a.md"]), "x").unwrap_err();
            let all_error = git_commit_all_inner(&path_str(&dir), "x").unwrap_err();

            let expected = format!("Cannot stop tracking .llm-wiki while a {word} is in progress");
            for error in [paths_error, all_error] {
                assert!(
                    error.contains(&expected),
                    "{marker}: unexpected error: {error}"
                );
            }
            assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head, "{marker}");
            assert!(
                git(&dir, &["ls-tree", "-r", "--name-only", "HEAD"]).contains(".llm-wiki/secret")
            );
        }
    }

    #[test]
    fn a_merge_in_progress_does_not_block_dropping_a_staged_only_llm_wiki_from_the_index() {
        // HEAD has no `.llm-wiki`; only the index does. The untracking then makes no
        // commit (it only runs `git rm --cached`), so the merge is not in its way.
        let dir = repo_with_committed_wiki();
        write(&dir, ".llm-wiki/secret", "v1");
        git(&dir, &["add", "-f", ".llm-wiki/secret"]);
        fs::write(
            dir.join(".git/MERGE_HEAD"),
            git(&dir, &["rev-parse", "HEAD"]),
        )
        .unwrap();
        write(&dir, "wiki/a.md", "a edited");

        let error =
            git_commit_paths_inner(&path_str(&dir), &strings(&["wiki/a.md"]), "x").unwrap_err();

        assert!(
            !error.contains("stop tracking"),
            "unexpected error: {error}"
        );
        assert_eq!(git(&dir, &["ls-files", ".llm-wiki"]).trim(), "");
        assert!(dir.join(".llm-wiki/secret").exists());
    }

    #[test]
    fn a_merge_in_progress_does_not_block_the_untracking_when_nothing_is_tracked() {
        // The untracking only matters when `.llm-wiki` is tracked. With nothing to
        // untrack it must not add its own refusal (git itself refuses a partial
        // commit during a merge).
        let dir = repo_with_committed_wiki();
        fs::write(
            dir.join(".git/MERGE_HEAD"),
            git(&dir, &["rev-parse", "HEAD"]),
        )
        .unwrap();
        write(&dir, "wiki/a.md", "a edited");

        let error =
            git_commit_paths_inner(&path_str(&dir), &strings(&["wiki/a.md"]), "x").unwrap_err();

        assert!(
            !error.contains("stop tracking"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn the_temporary_index_is_named_after_the_project_path() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let one = root.join("one");
        let two = root.join("two");
        fs::create_dir_all(&one).unwrap();
        fs::create_dir_all(&two).unwrap();

        let name_one = untrack_index_name(&path_str(&one));
        let name_two = untrack_index_name(&path_str(&two));

        assert_ne!(name_one, name_two);
        // The same project gives the same name, however its path is spelled.
        assert_eq!(
            name_one,
            untrack_index_name(&format!("{}/", path_str(&one)))
        );
        assert_eq!(
            name_one,
            untrack_index_name(&path_str(&one.join("..").join("one")))
        );
        assert!(name_one.starts_with("llm-wiki-untrack-") && name_one.ends_with(".index"));
        assert!(
            !name_one.contains(&std::process::id().to_string()),
            "the name must not depend on the process: {name_one}"
        );
    }

    #[test]
    fn two_projects_in_one_repo_untrack_without_sharing_an_index() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        for name in ["one", "two"] {
            write(&root, &format!("{name}/.llm-wiki/secret"), "v1");
            write(&root, &format!("{name}/wiki/a.md"), "# A");
        }
        git(&root, &["add", "-f", "-A"]);
        git(
            &root,
            &["commit", "-q", "-m", "old commit that tracked .llm-wiki"],
        );
        // A temporary index left by a crashed run of the other project must not matter.
        let leftover = root
            .join(".git")
            .join(untrack_index_name(&path_str(&root.join("two"))));
        fs::write(&leftover, "garbage from a crash").unwrap();

        git_commit_all_inner(&path_str(&root.join("one")), "chore: save").unwrap();

        let tree = git(&root, &["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(!tree.contains("one/.llm-wiki/"), "tree: {tree}");
        assert!(tree.contains("two/.llm-wiki/secret"), "tree: {tree}");
        // Each run removes its own temporary index and leaves the other project's alone.
        assert!(
            leftover.exists(),
            "another project's temporary index must stay"
        );
        assert!(!root
            .join(".git")
            .join(untrack_index_name(&path_str(&root.join("one"))))
            .exists());
    }

    // ── git_count_subjects ───────────────────────────────────────────────

    /// Write `rel` (so the commit has a change in its folder) and commit it with `subject`.
    /// Returns the full sha of the new commit.
    fn commit_file(dir: &Path, rel: &str, subject: &str) -> String {
        let previous = fs::read_to_string(dir.join(rel)).unwrap_or_default();
        write(dir, rel, &format!("{previous}{subject}\n"));
        git(dir, &["add", "--", rel]);
        git(
            dir,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--no-verify",
                "-m",
                subject,
            ],
        );
        git(dir, &["rev-parse", "HEAD"]).trim().to_string()
    }

    /// A repository with these commits, oldest first. Returns the repository and the sha of each commit.
    fn repo_with_subjects(subjects: &[&str]) -> (PathBuf, Vec<String>) {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        let shas = subjects
            .iter()
            .map(|subject| commit_file(&dir, "wiki/a.md", subject))
            .collect();
        (dir, shas)
    }

    #[test]
    fn count_subjects_counts_every_ingest_without_a_marker() {
        let (dir, _) = repo_with_subjects(&[
            "chore: start version history",
            "ingest: first (1 pages)",
            "chore: save changes before ingest",
            "ingest: second (2 pages)",
            "recut: move a page",
            "ingest: third (1 pages)",
        ]);

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), None, "ingest:").unwrap(),
            3
        );
    }

    #[test]
    fn count_subjects_counts_only_the_commits_after_since() {
        let (dir, shas) = repo_with_subjects(&[
            "ingest: first (1 pages)",
            "ingest: second (1 pages)",
            "chore: save changes before ingest",
            "ingest: third (1 pages)",
            "ingest: fourth (1 pages)",
        ]);
        let p = path_str(&dir);

        assert_eq!(
            git_count_subjects_inner(&p, Some(&shas[1]), "ingest:").unwrap(),
            2
        );
        assert_eq!(
            git_count_subjects_inner(&p, Some(&shas[0]), "ingest:").unwrap(),
            3
        );
    }

    #[test]
    fn count_subjects_is_zero_when_since_is_head() {
        let (dir, shas) =
            repo_with_subjects(&["ingest: first (1 pages)", "ingest: second (1 pages)"]);

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), Some(&shas[1]), "ingest:").unwrap(),
            0
        );
    }

    #[test]
    fn count_subjects_accepts_a_short_and_an_upper_case_since() {
        let (dir, shas) = repo_with_subjects(&[
            "ingest: first (1 pages)",
            "ingest: second (1 pages)",
            "ingest: third (1 pages)",
        ]);
        let p = path_str(&dir);

        assert_eq!(
            git_count_subjects_inner(&p, Some(&shas[0][..7]), "ingest:").unwrap(),
            2
        );
        assert_eq!(
            git_count_subjects_inner(&p, Some(&shas[0].to_uppercase()), "ingest:").unwrap(),
            2
        );
    }

    #[test]
    fn count_subjects_counts_all_when_since_is_not_in_the_history() {
        let (dir, _) = repo_with_subjects(&["ingest: first (1 pages)", "ingest: second (1 pages)"]);

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), Some("deadbeefdeadbeef"), "ingest:").unwrap(),
            2
        );
    }

    #[test]
    fn count_subjects_counts_all_when_since_is_not_an_ancestor_of_head() {
        let (dir, shas) =
            repo_with_subjects(&["ingest: first (1 pages)", "ingest: second (1 pages)"]);
        // The history is rewritten: the old commit stays in the object store, but HEAD no longer reaches it.
        git(&dir, &["reset", "--hard", "-q", "HEAD~1"]);
        commit_file(&dir, "wiki/b.md", "ingest: other (1 pages)");

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), Some(&shas[1]), "ingest:").unwrap(),
            2
        );
    }

    #[test]
    fn count_subjects_rejects_a_since_that_is_not_a_sha() {
        let (dir, _) = repo_with_subjects(&["ingest: first (1 pages)"]);
        let p = path_str(&dir);
        let planted = dir.join("planted");

        for bad in [
            "",
            "abc123",
            "HEAD",
            "main",
            "xyz1234",
            "--output=planted",
            "-p",
            "abcdef0 --output=planted",
            "abcdef0\n",
            &"a".repeat(65),
        ] {
            let result = git_count_subjects_inner(&p, Some(bad), "ingest:");
            assert!(result.is_err(), "{bad:?} must be refused, got {result:?}");
        }
        assert!(!planted.exists(), "git must not see the refused value");
    }

    #[test]
    fn count_subjects_matches_the_prefix_at_the_start_of_the_subject_only() {
        let (dir, _) = repo_with_subjects(&[
            "ingest: first (1 pages)",
            "chore: ingest: not a prefix",
            "Ingest: other case",
            " ingest: leading space",
            "ingest:no space",
            "reingest: other word",
        ]);

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), None, "ingest:").unwrap(),
            2
        );
    }

    #[test]
    fn count_subjects_refuses_an_empty_prefix() {
        let (dir, _) = repo_with_subjects(&["ingest: first (1 pages)"]);

        assert!(git_count_subjects_inner(&path_str(&dir), None, "").is_err());
    }

    #[test]
    fn count_subjects_is_zero_before_the_first_commit() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);

        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), None, "ingest:").unwrap(),
            0
        );
        assert_eq!(
            git_count_subjects_inner(&path_str(&dir), Some("deadbeefdeadbeef"), "ingest:").unwrap(),
            0
        );
    }

    #[test]
    fn count_subjects_errors_outside_a_repo() {
        assert!(git_count_subjects_inner(&path_str(&temp_dir()), None, "ingest:").is_err());
    }

    #[test]
    fn count_subjects_counts_only_commits_that_touch_the_project_folder() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        fs::create_dir_all(&project).unwrap();
        commit_file(&root, "other/a.md", "ingest: another folder (1 pages)");
        let marker = commit_file(&root, "wiki-p/wiki/a.md", "ingest: first (1 pages)");
        commit_file(
            &root,
            "other/a.md",
            "ingest: another folder again (1 pages)",
        );
        commit_file(&root, "wiki-p/wiki/a.md", "ingest: second (1 pages)");
        commit_file(
            &root,
            "wiki-p/wiki/b.md",
            "chore: save changes before ingest",
        );
        let p = path_str(&project);

        assert_eq!(git_count_subjects_inner(&p, None, "ingest:").unwrap(), 2);
        // The marker is a commit of the bigger repository.
        assert_eq!(
            git_count_subjects_inner(&p, Some(&marker), "ingest:").unwrap(),
            1
        );
    }

    /// The bundle of `wiki-tool`, which the app and the skills share.
    fn wiki_tool_bundle() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins/llm-wiki/scripts/wiki-tool.mjs")
    }

    /// `ingestsSince` of `wiki-tool lint changed-domains` for the project, or `None` when node is not installed.
    fn wiki_tool_ingests_since(project: &Path) -> Option<u32> {
        let bundle = wiki_tool_bundle();
        assert!(bundle.is_file(), "missing {}", bundle.display());
        let output = match Command::new("node")
            .arg(&bundle)
            .args(["lint", "changed-domains", "--project"])
            .arg(project)
            .output()
        {
            Ok(output) => output,
            Err(_) => return None,
        };
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| {
            panic!(
                "wiki-tool printed no JSON ({error}): {text} {}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
        assert_eq!(json["ok"], serde_json::Value::Bool(true), "output: {text}");
        Some(json["ingestsSince"].as_u64().expect("ingestsSince") as u32)
    }

    /// Make `dir` a mechanism wiki: the smallest `wiki.yaml` and `domains.yaml` that `wiki-tool lint` accepts.
    fn make_mechanism_wiki(dir: &Path) {
        write(dir, "wiki.yaml", "version: 1\nid: test\nrole: reading\n");
        write(
            dir,
            "domains.yaml",
            "version: 1\ndomains:\n  hardware/async-circuits:\n    lens: hardware\n    description: Placeholder domain\n",
        );
        fs::create_dir_all(dir.join("wiki")).unwrap();
    }

    /// Count the ingests of `project` since `since`, with a marker file for `wiki-tool` when there is a `since`.
    /// The count must be `expected`, a number fixed in the test, so the check holds when node is missing.
    /// When node runs, the count must also be the `ingestsSince` of the committed bundle.
    fn assert_ingest_count(name: &str, project: &Path, since: Option<&str>, expected: u32) {
        match since {
            Some(sha) => write(
                project,
                ".llm-wiki/semantic-lint.json",
                &format!("{{\"commit\":\"{sha}\",\"at\":\"2026-10-01T00:00:00.000Z\"}}"),
            ),
            // A marker of an earlier call must not reach the bundle.
            None => {
                let _ = fs::remove_file(project.join(".llm-wiki/semantic-lint.json"));
            }
        }
        let ours = git_count_subjects_inner(&path_str(project), since, "ingest:").unwrap();
        assert_eq!(ours, expected, "{name}: the fixed count");
        match wiki_tool_ingests_since(project) {
            Some(theirs) => {
                eprintln!("parity {name}: ours={ours} wiki-tool={theirs} expected={expected}");
                assert_eq!(ours, theirs, "{name}: the number of wiki-tool");
            }
            None => eprintln!(
                "parity {name}: ours={ours} expected={expected} (node is not installed: the bundle was not run)"
            ),
        }
    }

    #[test]
    fn count_subjects_gives_the_number_of_wiki_tool_changed_domains() {
        // Each case: the marker to write (if any) as a function of the commit shas, oldest first, and the count.
        // The counts were taken from `wiki-tool lint changed-domains` once. Four commits have an `ingest:` subject:
        // the ones at 1, 3, 5, and 7.
        type Marker = Box<dyn Fn(&[String]) -> String>;
        let cases: Vec<(&str, Option<Marker>, u32)> = vec![
            ("no marker", None, 4),
            ("full marker", Some(Box::new(|shas| shas[2].clone())), 3),
            (
                "short marker",
                Some(Box::new(|shas| shas[1][..7].to_string())),
                3,
            ),
            (
                "upper case marker",
                Some(Box::new(|shas| shas[1].to_uppercase())),
                3,
            ),
            (
                "marker at HEAD",
                Some(Box::new(|shas| shas[shas.len() - 1].clone())),
                0,
            ),
            (
                "marker not in history",
                Some(Box::new(|_| "deadbeefdeadbeef".to_string())),
                4,
            ),
        ];
        let subjects = [
            "chore: start version history",
            "ingest: first (1 pages)",
            "chore: save changes before ingest",
            "ingest: second (1 pages)",
            "chore: ingest: not a prefix",
            "ingest:third (2 pages)",
            "recut: move a page",
            "ingest: fourth (1 pages)",
        ];

        for (name, marker, expected) in cases {
            let dir = temp_dir();
            init_repo_with_identity(&dir);
            make_mechanism_wiki(&dir);
            git(&dir, &["add", "wiki.yaml", "domains.yaml"]);
            let mut shas = Vec::new();
            for subject in subjects {
                shas.push(commit_file(&dir, "wiki/a.md", subject));
            }
            let since = marker.map(|pick| pick(&shas));
            assert_ingest_count(name, &dir, since.as_deref(), expected);
        }
    }

    #[test]
    fn count_subjects_gives_the_number_of_wiki_tool_for_other_histories() {
        // The marker is a commit that is no ancestor of HEAD: every ingest counts.
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        make_mechanism_wiki(&dir);
        git(&dir, &["add", "wiki.yaml", "domains.yaml"]);
        commit_file(&dir, "wiki/a.md", "ingest: first (1 pages)");
        let stray = commit_file(&dir, "wiki/a.md", "ingest: second (1 pages)");
        git(&dir, &["reset", "--hard", "-q", "HEAD~1"]);
        commit_file(&dir, "wiki/b.md", "ingest: other (1 pages)");
        assert_ingest_count("marker is no ancestor of HEAD", &dir, Some(&stray), 2);

        // No commit yet.
        let empty = temp_dir();
        init_repo_with_identity(&empty);
        make_mechanism_wiki(&empty);
        assert_ingest_count("no commit", &empty, None, 0);

        // The wiki is a folder of a bigger repository.
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        make_mechanism_wiki(&project);
        git(&root, &["add", "wiki-p/wiki.yaml", "wiki-p/domains.yaml"]);
        git(
            &root,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--no-verify",
                "-m",
                "chore: start version history",
            ],
        );
        commit_file(&root, "other/a.md", "ingest: another folder (1 pages)");
        let marker = commit_file(&root, "wiki-p/wiki/a.md", "ingest: first (1 pages)");
        commit_file(
            &root,
            "other/a.md",
            "ingest: another folder again (1 pages)",
        );
        commit_file(&root, "wiki-p/wiki/a.md", "ingest: second (1 pages)");
        assert_ingest_count("nested project, with a marker", &project, Some(&marker), 1);
        assert_ingest_count("nested project, no marker", &project, None, 2);
    }
}
