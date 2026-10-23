//! Git-backed version history for wiki projects.
//!
//! Every successful ingest becomes one commit in the project folder, and a
//! failed or cancelled ingest restores `wiki/` to the last commit. These
//! commands shell out to the user's `git`; none of them ever writes to the
//! user's git config.

use std::fs;
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
/// Top-level folders `git_restore_dir` refuses: sources and secrets/caches.
const PROTECTED_TOP_LEVEL_DIRS: [&str; 2] = ["raw", ".llm-wiki"];
const INIT_COMMIT_MESSAGE: &str = "chore: start version history";
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

/// Run `git -C <project_path> <args...>` with extra environment variables.
/// `LC_ALL=C` keeps git's messages stable so they can be matched.
fn run_git_with_env(
    project_path: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<GitOutput, String> {
    let git = resolve_git().ok_or_else(|| "git is not installed or not runnable".to_string())?;
    let mut cmd = Command::new(git);
    suppress_windows_console(&mut cmd);
    cmd.arg("-C")
        .arg(project_path)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    let output = cmd
        .output()
        .map_err(|error| format!("Failed to run git: {error}"))?;
    Ok(GitOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
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

fn git_info_inner(project_path: &str) -> GitInfo {
    if resolve_git().is_none() {
        return GitInfo {
            available: false,
            is_repo: false,
        };
    }
    let is_repo = run_git(project_path, &["rev-parse", "--is-inside-work-tree"])
        .map(|output| output.success && output.stdout.trim() == "true")
        .unwrap_or(false);
    GitInfo {
        available: true,
        is_repo,
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

/// Ignoring `.llm-wiki/` does not untrack files an older commit already
/// recorded, and a path-limited `commit -- .` takes such a file's current
/// content from disk, so it would keep committing the secret. Drop the files
/// from the index (they stay on disk). Returns true when `.llm-wiki` is in the
/// index or in HEAD, i.e. when this commit has to carry its removal.
fn untrack_llm_wiki(project_path: &str, envs: &[(&str, &str)]) -> Result<bool, String> {
    let in_index = !run_git_ok(project_path, &["ls-files", "--", ".llm-wiki"], envs)?
        .stdout
        .trim()
        .is_empty();
    let has_head =
        run_git_with_env(project_path, &["rev-parse", "--verify", "-q", "HEAD"], envs)?.success;
    let in_head = has_head
        && !run_git_ok(
            project_path,
            &["ls-tree", "-r", "--name-only", "HEAD", "--", ".llm-wiki"],
            envs,
        )?
        .stdout
        .trim()
        .is_empty();
    if !in_index && !in_head {
        return Ok(false);
    }
    // The removal is committed without a pathspec (see `git_commit_all_with_env`),
    // which takes the whole index: refuse rather than sweep in staged changes
    // that belong to the repository outside this project folder.
    let outside_args = ["diff", "--cached", "--quiet", "--", ":(top)", ":(exclude)."];
    let outside = run_git_with_env(project_path, &outside_args, envs)?;
    match outside.code {
        Some(0) => {}
        Some(1) => return Err(
            "Cannot stop tracking .llm-wiki/ while changes outside this project folder are staged"
                .to_string(),
        ),
        _ => return Err(outside.failure_message(&outside_args)),
    }
    if in_index {
        run_git_ok(
            project_path,
            &["rm", "-r", "--cached", "-q", "--", ".llm-wiki"],
            envs,
        )?;
    }
    Ok(true)
}

fn git_commit_all_with_env(
    project_path: &str,
    message: &str,
    envs: &[(&str, &str)],
) -> Result<Option<String>, String> {
    ensure_llm_wiki_ignored(project_path, envs)?;
    let carries_llm_wiki_removal = untrack_llm_wiki(project_path, envs)?;
    run_git_ok(project_path, &["add", "-A", "--", "."], envs)?;

    let diff_args = ["diff", "--cached", "--quiet", "--", "."];
    let diff = run_git_with_env(project_path, &diff_args, envs)?;
    match diff.code {
        Some(0) => return Ok(None),
        Some(1) => {}
        _ => return Err(diff.failure_message(&diff_args)),
    }

    // Use the fallback identity only for the parts the user has not configured.
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
    args.extend(["commit", "--no-verify", "-m", message].map(String::from));
    if !carries_llm_wiki_removal {
        // Path-limited: keeps staged changes outside a nested project folder out.
        args.extend(["--", "."].map(String::from));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_ok(project_path, &arg_refs, envs)?;

    let head = run_git_ok(project_path, &["rev-parse", "HEAD"], envs)?;
    Ok(Some(head.stdout.trim().to_string()))
}

/// True when `git config <key>` prints a non-empty value.
fn has_config(project_path: &str, key: &str, envs: &[(&str, &str)]) -> Result<bool, String> {
    let output = run_git_with_env(project_path, &["config", key], envs)?;
    Ok(output.success && !output.stdout.trim().is_empty())
}

fn git_commit_all_inner(project_path: &str, message: &str) -> Result<Option<String>, String> {
    git_commit_all_with_env(project_path, message, &[])
}

/// Accept only a relative path that names a folder inside the project and is
/// not the whole project, `raw/` or `.llm-wiki/` (a failed ingest never
/// touches those). Both `/` and `\\` count as separators so the check holds on
/// every platform, and `.` / empty segments are ignored.
fn validate_relative_dir(relative_dir: &str) -> Result<(), String> {
    let invalid = || format!("Invalid directory: {relative_dir:?}");
    if relative_dir.trim().is_empty() {
        return Err(invalid());
    }
    let looks_absolute = relative_dir.starts_with('/')
        || relative_dir.starts_with('\\')
        || Path::new(relative_dir).is_absolute()
        || relative_dir.as_bytes().get(1) == Some(&b':');
    // A leading ':' would be read as git pathspec magic such as `:(top)`.
    if looks_absolute || relative_dir.starts_with(':') {
        return Err(invalid());
    }
    let segments: Vec<&str> = relative_dir
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.contains(&"..") {
        return Err(invalid());
    }
    // `.` / `./` would restore and clean the whole project.
    let Some(first) = segments.first() else {
        return Err(invalid());
    };
    if PROTECTED_TOP_LEVEL_DIRS
        .iter()
        .any(|protected| first.eq_ignore_ascii_case(protected))
    {
        return Err(format!(
            "Refusing to restore {relative_dir:?}: {first} is never touched"
        ));
    }
    Ok(())
}

fn git_restore_dir_inner(project_path: &str, relative_dir: &str) -> Result<(), String> {
    validate_relative_dir(relative_dir)?;
    let dir_existed = Path::new(project_path).join(relative_dir).is_dir();

    // `--literal-pathspecs`: the directory is a plain path, never a glob.
    let restore_args = [
        "--literal-pathspecs",
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        relative_dir,
    ];
    let restore = run_git(project_path, &restore_args)?;
    // A folder holding only new, untracked files has nothing in HEAD to
    // restore; git reports that as an error but the clean below finishes it.
    if !restore.success
        && !restore
            .stderr
            .contains("did not match any file(s) known to git")
    {
        return Err(restore.failure_message(&restore_args));
    }

    // No `-x`: ignored files (such as Obsidian workspace state) are kept.
    run_git_ok(
        project_path,
        &["--literal-pathspecs", "clean", "-fd", "--", relative_dir],
        &[],
    )?;

    // `clean -d` removes a folder that held only untracked files; put the
    // empty folder back so later writes into it still work.
    if dir_existed {
        let dir = Path::new(project_path).join(relative_dir);
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .map_err(|error| format!("Failed to recreate {relative_dir}: {error}"))?;
        }
    }
    Ok(())
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
        .unwrap_or(GitInfo {
            available: false,
            is_repo: false,
        })
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
pub async fn git_restore_dir(project_path: String, relative_dir: String) -> Result<(), String> {
    run_blocking("Git restore", move || {
        git_restore_dir_inner(&project_path, &relative_dir)
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
    }

    #[test]
    fn info_reports_repo() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        let info = git_info_inner(&path_str(&dir));
        assert!(info.available);
        assert!(info.is_repo);
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

    fn repo_with_committed_wiki() -> PathBuf {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "wiki/a.md", "committed text");
        git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();
        dir
    }

    #[test]
    fn restore_dir_reverts_modified_and_removes_new_files() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "changed by a failed ingest");
        write(&dir, "wiki/b.md", "new file");
        write(&dir, "wiki/sub/c.md", "new nested file");

        git_restore_dir_inner(&path_str(&dir), "wiki").unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("wiki/a.md")).unwrap(),
            "committed text"
        );
        assert!(!dir.join("wiki/b.md").exists());
        assert!(!dir.join("wiki/sub").exists());
    }

    #[test]
    fn restore_dir_brings_back_deleted_files() {
        let dir = repo_with_committed_wiki();
        fs::remove_file(dir.join("wiki/a.md")).unwrap();

        git_restore_dir_inner(&path_str(&dir), "wiki").unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("wiki/a.md")).unwrap(),
            "committed text"
        );
    }

    #[test]
    fn restore_dir_unstages_staged_changes() {
        let dir = repo_with_committed_wiki();
        write(&dir, "wiki/a.md", "staged change");
        write(&dir, "wiki/b.md", "staged new file");
        git(&dir, &["add", "-A"]);

        git_restore_dir_inner(&path_str(&dir), "wiki").unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("wiki/a.md")).unwrap(),
            "committed text"
        );
        assert!(!dir.join("wiki/b.md").exists());
        assert_eq!(git(&dir, &["status", "--porcelain"]).trim(), "");
    }

    #[test]
    fn restore_dir_handles_a_folder_with_only_new_untracked_files() {
        let dir = temp_dir();
        init_repo_with_identity(&dir);
        write(&dir, ".gitignore", ".llm-wiki/\n");
        write(&dir, "raw/sources/seed.md", "seed");
        git_commit_all_inner(&path_str(&dir), "chore: start").unwrap();
        // `wiki/` holds nothing tracked: `git restore` reports "pathspec did not match".
        write(&dir, "wiki/new.md", "new");
        write(&dir, "wiki/deep/new2.md", "new");

        git_restore_dir_inner(&path_str(&dir), "wiki").unwrap();

        assert!(!dir.join("wiki/new.md").exists());
        assert!(!dir.join("wiki/deep").exists());
        assert!(
            dir.join("wiki").is_dir(),
            "the wiki folder itself must remain"
        );
        assert!(dir.join("raw/sources/seed.md").exists());
    }

    #[test]
    fn restore_dir_leaves_other_folders_alone() {
        let dir = repo_with_committed_wiki();
        write(&dir, "raw/sources/new.md", "new source");
        write(&dir, ".llm-wiki/cache.json", "{}");
        write(&dir, "wiki/b.md", "new file");

        git_restore_dir_inner(&path_str(&dir), "wiki").unwrap();

        assert!(dir.join("raw/sources/new.md").exists());
        assert!(dir.join(".llm-wiki/cache.json").exists());
        assert!(!dir.join("wiki/b.md").exists());
    }

    #[test]
    fn restore_dir_rejects_unsafe_paths() {
        let dir = repo_with_committed_wiki();
        let p = path_str(&dir);
        for bad in [
            "../x",
            "/abs",
            "wiki/../..",
            "wiki\\..\\..",
            "C:\\abs",
            "\\abs",
            "",
            ":(top)wiki",
        ] {
            assert!(
                git_restore_dir_inner(&p, bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn restore_dir_stays_inside_a_nested_project_folder() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("wiki-p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/a.md", "committed text");
        write(&root, "wiki/outer.md", "outer");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "seed"]);

        write(&project, "wiki/a.md", "changed");
        write(&root, "wiki/outer.md", "outer changed");

        git_restore_dir_inner(&path_str(&project), "wiki").unwrap();

        assert_eq!(
            fs::read_to_string(project.join("wiki/a.md")).unwrap(),
            "committed text"
        );
        assert_eq!(
            fs::read_to_string(root.join("wiki/outer.md")).unwrap(),
            "outer changed"
        );
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

    #[test]
    fn restore_dir_rejects_unsafe_paths_in_a_nested_project() {
        let root = temp_dir();
        init_repo_with_identity(&root);
        let project = root.join("p");
        write(&project, ".gitignore", ".llm-wiki/\n");
        write(&project, "wiki/a.md", "committed");
        write(&root, "outer/o.md", "outer committed");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "seed"]);
        write(&root, "outer/o.md", "outer edited, uncommitted");
        write(&root, "outer/new.md", "outer untracked");

        let outer_abs = path_str(&root.join("outer"));
        for bad in ["../outer", outer_abs.as_str(), "wiki/../../outer"] {
            assert!(
                git_restore_dir_inner(&path_str(&project), bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }

        assert_eq!(
            fs::read_to_string(root.join("outer/o.md")).unwrap(),
            "outer edited, uncommitted"
        );
        assert!(root.join("outer/new.md").exists());
    }

    #[test]
    fn restore_dir_refuses_the_whole_project_raw_and_llm_wiki() {
        let dir = repo_with_committed_wiki();
        write(&dir, "raw/sources/s.md", "source committed");
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-m", "add raw"]);
        write(&dir, "raw/sources/s.md", "source edited");
        write(&dir, "raw/sources/untracked.md", "untracked source");
        write(&dir, ".llm-wiki/cache.json", "{}");
        write(&dir, "wiki/a.md", "edited wiki");
        let p = path_str(&dir);

        for bad in [
            ".",
            "./",
            "./.",
            "raw",
            "raw/",
            "raw/sources",
            "./raw",
            "RAW",
            ".llm-wiki",
            ".llm-wiki/cache.json",
            "./.llm-wiki",
            "raw\\sources",
        ] {
            assert!(
                git_restore_dir_inner(&p, bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }

        assert_eq!(
            fs::read_to_string(dir.join("raw/sources/s.md")).unwrap(),
            "source edited"
        );
        assert!(dir.join("raw/sources/untracked.md").exists());
        assert!(dir.join(".llm-wiki/cache.json").exists());
        assert_eq!(
            fs::read_to_string(dir.join("wiki/a.md")).unwrap(),
            "edited wiki"
        );
        // Folders that merely contain the words are still fine.
        git_restore_dir_inner(&p, "wiki").unwrap();
        git_restore_dir_inner(&p, "wiki/raw").unwrap();
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
    fn commit_all_refuses_to_untrack_llm_wiki_over_staged_changes_outside_the_project() {
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
        let head_before = git(&root, &["rev-parse", "HEAD"]);

        let result = git_commit_all_inner(&path_str(&project), "ingest: A (1 pages)");

        assert!(result.is_err());
        assert_eq!(git(&root, &["rev-parse", "HEAD"]), head_before);
        assert!(git(&root, &["show", "HEAD:p/.llm-wiki/secret"]).contains("v1"));
        assert_eq!(
            fs::read_to_string(project.join(".llm-wiki/secret")).unwrap(),
            "v2 changed since"
        );
    }
}
