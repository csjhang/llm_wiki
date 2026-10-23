//! Git-backed version history for wiki projects.
//!
//! Every successful ingest becomes one commit that holds only the paths that
//! ingest wrote, and a failed or cancelled ingest restores only those paths to
//! the last commit. These commands shell out to the user's `git`; none of them
//! ever writes to the user's git config.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

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
    git_init_with_env(project_path, &[])
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

/// Ignoring `.llm-wiki/` does not untrack files an older commit recorded, and
/// a path-limited commit takes such a file's current content from disk, so it
/// would keep committing the secret. When HEAD has `.llm-wiki` files, record
/// their removal as its own `chore: stop tracking .llm-wiki` commit, built in a
/// temporary index from HEAD so it holds nothing else: no staged change of the
/// user and nothing outside a nested project folder. Then drop the files from
/// the real index (they stay on disk). Returns true when it made that commit.
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

    if in_head {
        let git_dir = run_git_ok(project_path, &["rev-parse", "--absolute-git-dir"], envs)?
            .stdout
            .trim()
            .to_string();
        let temp_index =
            Path::new(&git_dir).join(format!("llm-wiki-untrack-{}.index", std::process::id()));
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
    git_commit_all_with_env(project_path, message, &[])
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

fn exists_on_disk(project_path: &str, rel: &str) -> bool {
    fs::symlink_metadata(Path::new(project_path).join(rel)).is_ok()
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
    let to_add: Vec<String> = paths
        .iter()
        .filter(|path| {
            covers(path, &in_index)
                || (exists_on_disk(project_path, &path.rel) && !ignored.contains(&path.rel))
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
    git_commit_paths_with_env(project_path, paths, message, &[])
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
    let all = rels(&paths);
    let in_index = index_entries(project_path, &all, &[])?;
    let in_head = head_entries(project_path, &all, &[])?;
    let root = Path::new(project_path);

    // Tell the file watcher these changes come from the app, so a deleted
    // page is not handled as an external delete.
    for path in &paths {
        crate::commands::file_sync::mark_app_write_path(&root.join(&path.rel));
    }

    let known: Vec<String> = paths
        .iter()
        .filter(|path| covers(path, &in_index) || covers(path, &in_head))
        .map(|path| path.rel.clone())
        .collect();
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

    let unknown_files: Vec<String> = paths
        .iter()
        .filter(|path| !path.is_dir && !known.contains(&path.rel))
        .filter(|path| {
            fs::symlink_metadata(root.join(&path.rel))
                .map(|meta| !meta.is_dir())
                .unwrap_or(false)
        })
        .map(|path| path.rel.clone())
        .collect();
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
}
