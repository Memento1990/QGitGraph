//! Read-only Git queries. This implementation uses only Git's documented CLI.
//!
//! Comparison targets: `ROOT` is an empty tree, `INDEX` is the index, and
//! `WORKTREE` includes tracked and untracked worktree changes. WORKTREE/INDEX
//! default to HEAD (or ROOT for an unborn branch); commit targets with no base
//! default to ROOT. Explicit `base=INDEX,target=WORKTREE` is unstaged-only.
//! All paths are repository-relative and literal (`GitService` sets
//! GIT_LITERAL_PATHSPECS=1); user revisions are resolved to verified commit OIDs.

use std::collections::{HashMap, HashSet};
use std::fs;
#[cfg(windows)]
use std::fs::File;
use std::io::Read;
use std::path::Path;

use encoding_rs::Encoding;

#[path = "history.rs"]
mod history;
#[path = "object_batch.rs"]
mod object_batch;
#[path = "queries.rs"]
mod queries;

use super::{parse, GitService};
use crate::error::{AppError, Result};
use crate::model::*;

const LOG_FORMAT: &str = "tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s";
const LOG_FORMAT_MAILMAP: &str = "tformat:%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s";
const DETAIL_FORMAT: &str =
    "tformat:%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%cn%x00%ce%x00%b";
const DETAIL_FORMAT_MAILMAP: &str =
    "tformat:%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%s%x00%cN%x00%cE%x00%b";
const REF_FORMAT: &str = "%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)%00%(upstream)%00%(HEAD)%00%(subject)%00";
const CONTENT_LIMIT: usize = 2 * 1024 * 1024;
const PATCH_LIMIT: usize = 4 * 1024 * 1024;
type SubmoduleParent = Option<(usize, String, String)>;
type SafeWorkingStates = Vec<(WorkingState, SubmoduleParent)>;

fn argument(message: impl Into<String>) -> AppError {
    AppError::new("ARGUMENT", message)
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new("IO", error.to_string())
}

/// Accept only HEAD, commit hex IDs, validated full refs and numbered stashes.
/// No option-like arguments, shorthand branch names, revision expressions,
/// ranges, reflog dates, path/object selectors, or `@{-1}` are accepted.
pub fn validate_revision(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 1024 || value.starts_with('-') || value.contains('\0') {
        return Err(argument("Invalid revision"));
    }
    if value == "HEAD" || parse::is_oid(value) {
        return Ok(());
    }
    if let Some(number) = value
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
    {
        if !number.is_empty() && number.len() <= 10 && number.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(());
        }
        return Err(argument("A stash selector must be stash@{N}"));
    }
    if !value.starts_with("refs/")
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(c))
        || value
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return Err(argument(
            "Use HEAD, a commit hash, a full refs/... name, or stash@{N}",
        ));
    }
    Ok(())
}

/// Validate an exact repository-relative file path, not a pathspec expression.
/// Backslashes, drive paths, ADS, traversal and .git administrative paths are
/// rejected on every platform so a saved query cannot become unsafe on Windows.
pub fn validate_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 32768
        || value.starts_with('/')
        || value.contains('\0')
        || value.contains('\\')
        || value.contains(':')
    {
        return Err(argument("The file path must be repository-relative"));
    }
    for component in value.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(argument(
                "Empty and traversal path components are not allowed",
            ));
        }
        if component
            .trim_end_matches([' ', '.'])
            .eq_ignore_ascii_case(".git")
        {
            return Err(argument(
                "Git administrative files cannot be opened as worktree files",
            ));
        }
        #[cfg(windows)]
        {
            if component.ends_with([' ', '.'])
                || component
                    .chars()
                    .any(|c| c.is_control() || "<>\"|?*".contains(c))
            {
                return Err(argument("The path contains a name unsupported by Windows"));
            }
            let stem = component
                .split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase();
            if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || stem.strip_prefix("COM").is_some_and(|s| {
                    matches!(s, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
                || stem.strip_prefix("LPT").is_some_and(|s| {
                    matches!(s, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
            {
                return Err(argument("Windows device paths cannot be read"));
            }
        }
    }
    Ok(())
}

/// The runner enforces GIT_LITERAL_PATHSPECS=1. Adding :(literal) here would
/// incorrectly make those characters part of the filename under that setting.
pub fn literal_pathspec(value: &str) -> Result<String> {
    validate_path(value)?;
    Ok(value.to_owned())
}

/// Worktree-aware operation markers live in the per-worktree git_dir rather
/// than common_dir. Non-NotFound I/O errors must not masquerade as idle state.
pub fn operation_state(repo: &Repository) -> Result<Option<String>> {
    let directory = Path::new(&repo.git_dir);
    for (marker, operation) in [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        match fs::symlink_metadata(directory.join(marker)) {
            Ok(_) => return Ok(Some(operation.to_owned())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    let sequence = directory.join("sequencer/todo");
    match fs::read(&sequence) {
        Ok(bytes) => {
            for line in bytes.split(|b| *b == b'\n') {
                if line.starts_with(b"revert ") {
                    return Ok(Some("revert".into()));
                }
                if line.starts_with(b"pick ") {
                    return Ok(Some("cherry-pick".into()));
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    Ok(None)
}

#[derive(Clone, Debug)]
enum Side {
    Root,
    Commit(String),
    Index,
    Worktree,
}

struct Comparison {
    base: Side,
    target: Side,
    // Set only from a parsed commit, never from the requested ROOT sentinel.
    target_is_root: bool,
}

struct Content {
    bytes: Option<Vec<u8>>,
    binary: bool,
    truncated: bool,
}

enum ContentSource {
    Ready(Content),
    Blob { oid: String, size: Option<usize> },
}

impl Content {
    fn absent() -> Self {
        Self {
            bytes: None,
            binary: false,
            truncated: false,
        }
    }
    fn bytes(bytes: Vec<u8>) -> Self {
        Self {
            bytes: Some(bytes),
            binary: false,
            truncated: false,
        }
    }
    fn too_large() -> Self {
        Self {
            bytes: None,
            binary: false,
            truncated: true,
        }
    }
}

impl GitService {
    /// Resolves a validated user-supplied target, with Git's end-of-options
    /// protection, and returns only a full commit OID (SHA-1 or SHA-256).
    pub async fn resolve_revision(
        &self,
        repo: &Repository,
        request_id: &str,
        revision: &str,
    ) -> Result<String> {
        validate_revision(revision)?;
        let output = self
            .run(
                repo,
                request_id,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--end-of-options".into(),
                    format!("{revision}^{{commit}}"),
                ],
                false,
            )
            .await?;
        parse_oid_line(&output)
    }

    async fn optional_head(&self, repo: &Repository, request_id: &str) -> Result<Option<String>> {
        let output = self
            .run_output(
                repo,
                request_id,
                vec![
                    "rev-parse".into(),
                    "--verify".into(),
                    "--quiet".into(),
                    "--end-of-options".into(),
                    "HEAD^{commit}".into(),
                ],
                None,
                false,
            )
            .await?;
        match output.code {
            0 => {
                let oid = std::str::from_utf8(&output.stdout)
                    .map_err(|_| AppError::new("GIT_PARSE", "Non-ASCII HEAD object ID"))?;
                return parse_oid_line(oid).map(Some);
            }
            1 if output.stdout.is_empty() && output.stderr.is_empty() => {}
            _ => return Err(AppError::git(String::from_utf8_lossy(&output.stderr))),
        }
        // Quiet verification also exits 1 for a missing/non-commit object. Only
        // the uncommon empty-HEAD path needs a second command to distinguish
        // an unborn branch from a broken ref; normal HEAD costs one launch.
        let output = self
            .run_output(
                repo,
                request_id,
                vec![
                    "rev-parse".into(),
                    "--revs-only".into(),
                    "--end-of-options".into(),
                    "HEAD".into(),
                ],
                None,
                false,
            )
            .await?;
        if output.code == 0 && output.stdout.is_empty() && output.stderr.is_empty() {
            Ok(None)
        } else {
            Err(AppError::git("HEAD does not resolve to an existing commit"))
        }
    }

    pub async fn refs(&self, repo: &Repository, request_id: &str) -> Result<Vec<GitRef>> {
        self.reference_state(repo, request_id)
            .await
            .map(|(refs, _)| refs)
    }

    /// Read ref decorations and full stash metadata once for a snapshot. Stash
    /// timestamps are not reconstructible from GitRef, so share the actual list
    /// instead of calling `stash list` again or keeping a stale cross-query cache.
    pub async fn reference_state(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<(Vec<GitRef>, Vec<Stash>)> {
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "for-each-ref".into(),
                    format!("--format={REF_FORMAT}"),
                    "refs/heads/".into(),
                    "refs/remotes/".into(),
                    "refs/tags/".into(),
                    "refs/stash".into(),
                ],
                false,
            )
            .await?;
        let mut refs = parse::refs(&bytes)?;
        for item in &refs {
            validate_revision(&item.full_name)?;
            if let Some(upstream) = &item.upstream {
                validate_revision(upstream)?;
            }
        }
        // Every stash entry is a graph decoration, not merely refs/stash's tip.
        refs.retain(|item| item.kind != "stash");
        let stashes = self.stashes(repo, request_id).await?;
        for stash in &stashes {
            refs.push(GitRef {
                name: stash.selector.clone(),
                full_name: stash.selector.clone(),
                oid: stash.oid.clone(),
                kind: "stash".into(),
                upstream: None,
                current: false,
                subject: stash.message.clone(),
            });
        }
        Ok((refs, stashes))
    }

    /// Status and worktree diffs can run clean/process filters even with
    /// --no-ext-diff/--no-textconv. Enumerate effective config without invoking
    /// converters; include/includeIf must be visible too, or they bypass trust.
    async fn ensure_trusted_filters(&self, repo: &Repository, request_id: &str) -> Result<()> {
        if repo.trusted {
            return Ok(());
        }
        let output = self
            .run_output(
                repo,
                request_id,
                vec![
                    "config".into(),
                    "--null".into(),
                    "--includes".into(),
                    "--get-regexp".into(),
                    r"^filter\..*\.(clean|smudge|process|required)$".into(),
                ],
                None,
                false,
            )
            .await?;
        match output.code {
            0 => Err(AppError::new(
                "UNTRUSTED_FILTER",
                "This repository configures Git content filters. Trust it before reading working status or worktree diffs; filters can execute commands.",
            )),
            1 if output.stdout.is_empty() && output.stderr.is_empty() => Ok(()),
            _ => Err(AppError::git(
                "Could not safely check Git content-filter configuration.",
            )),
        }
    }

    pub async fn working_state(&self, repo: &Repository, request_id: &str) -> Result<WorkingState> {
        let _request = self.request_scope(request_id)?;
        let started = std::time::Instant::now();
        let mut pending = vec![(self.clone(), repo.clone(), 0_usize, None)];
        let mut completed = SafeWorkingStates::new();
        let mut visited = HashSet::new();
        while let Some((service, current, depth, parent)) = pending.pop() {
            self.check_request(request_id)?;
            if started.elapsed() > std::time::Duration::from_secs(30)
                || completed.len() + pending.len() >= 256
                || depth > 5
                || !visited.insert(fs::canonicalize(&current.path).map_err(io_error)?)
            {
                return Err(AppError::new("SUBMODULE_LIMIT", "Safe submodule status exceeded its depth, repository or time budget. Working state is unknown; no recursive Git status was run."));
            }
            let state = service.working_state_shallow(&current, request_id).await?;
            let index = completed.len();
            completed.push((state, parent));
            if current.bare {
                continue;
            }
            let entries = parse::index_entries(
                &service
                    .run_bytes(
                        &current,
                        request_id,
                        vec!["ls-files".into(), "--stage".into(), "-z".into()],
                        false,
                    )
                    .await?,
            )?;
            let mut links = HashMap::new();
            for entry in entries.into_iter().filter(|entry| entry.mode == "160000") {
                if entry.stage == 0 || entry.stage == 2 {
                    links.insert(entry.path, entry.oid);
                }
            }
            for (path, oid) in links {
                self.check_request(request_id)?;
                if depth >= 5
                    || completed.len() + pending.len() >= 256
                    || started.elapsed() > std::time::Duration::from_secs(30)
                {
                    return Err(AppError::new("SUBMODULE_LIMIT", "Safe submodule status exceeded its depth, repository or time budget. Working state is unknown; no recursive Git status was run."));
                }
                let Some(root) = queries::submodule_root(&current, &path)? else {
                    continue;
                };
                let child_path = crate::state::display_path(&root);
                let mut child = Repository {
                    id: String::new(),
                    path: child_path.clone(),
                    name: String::new(),
                    git_dir: String::new(),
                    common_dir: String::new(),
                    head: None,
                    branch: None,
                    trusted: false,
                    bare: false,
                };
                let probe = service.nested_probe_service(request_id)?;
                let output = probe
                    .run(
                        &child,
                        request_id,
                        vec![
                            "rev-parse".into(),
                            "--path-format=absolute".into(),
                            "--absolute-git-dir".into(),
                            "--git-common-dir".into(),
                        ],
                        false,
                    )
                    .await?;
                let directories: Vec<_> = output.lines().collect();
                if directories.len() != 2 {
                    return Err(AppError::new(
                        "GIT_PARSE",
                        "Invalid submodule discovery output.",
                    ));
                }
                child.id = child_path;
                child.git_dir = directories[0].into();
                child.common_dir = directories[1].into();
                let reader = service.nested_read_service(&child, request_id)?;
                // 子仓始终单独核验过滤器，不从父仓继承 trusted；禁止 Git 内部递归。
                pending.push((reader, child, depth + 1, Some((index, path, oid))));
            }
        }
        for index in (1..completed.len()).rev() {
            let (state, parent) = &completed[index];
            let (parent, path, oid) = parent.clone().expect("child status has a parent");
            let commit_changed = state.head.as_deref().is_some_and(|head| head != oid);
            let untracked = state.files.iter().any(|file| {
                file.status == "?" || file.submodule.as_ref().is_some_and(|sub| sub.untracked)
            });
            let modified = state.files.iter().any(|file| {
                file.submodule.as_ref().map_or(file.status != "?", |sub| {
                    file.staged || sub.commit_changed || sub.modified
                })
            });
            let parent_state = &mut completed[parent].0;
            if let Some(file) = parent_state.files.iter_mut().find(|file| file.path == path) {
                file.submodule = Some(SubmoduleStatus {
                    commit_changed,
                    modified,
                    untracked,
                });
                if commit_changed || modified || untracked {
                    file.unstaged = true;
                    if file.status.len() == 2 && file.status.ends_with('.') {
                        file.status.replace_range(1..2, "M");
                    }
                }
            } else if commit_changed || modified || untracked {
                parent_state.files.push(ChangedFile {
                    path,
                    old_path: None,
                    status: ".M".into(),
                    additions: None,
                    deletions: None,
                    staged: false,
                    unstaged: true,
                    submodule: Some(SubmoduleStatus {
                        commit_changed,
                        modified,
                        untracked,
                    }),
                });
            }
        }
        Ok(completed.remove(0).0)
    }

    async fn working_state_shallow(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<WorkingState> {
        if repo.bare {
            let head = self.optional_head(repo, request_id).await?;
            // symbolic-ref also works for an unborn bare repository. Exit 1
            // means detached HEAD; other failures must not become a fake branch.
            let output = self
                .run_output(
                    repo,
                    request_id,
                    vec!["symbolic-ref".into(), "--quiet".into(), "HEAD".into()],
                    None,
                    false,
                )
                .await?;
            let branch = match output.code {
                0 => {
                    let branch = String::from_utf8(output.stdout)
                        .map_err(|_| AppError::new("GIT_PARSE", "HEAD ref is not valid UTF-8"))?;
                    let branch = branch.trim();
                    validate_revision(branch)?;
                    branch.strip_prefix("refs/heads/").map(str::to_owned)
                }
                1 => None,
                _ => return Err(AppError::git(String::from_utf8_lossy(&output.stderr))),
            };
            return Ok(WorkingState {
                files: Vec::new(),
                branch,
                upstream: None,
                tracking_known: false,
                ahead: 0,
                behind: 0,
                operation: operation_state(repo)?,
                conflicts: 0,
                head,
            });
        }
        self.ensure_trusted_filters(repo, request_id).await?;
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "status".into(),
                    "--porcelain=v2".into(),
                    "--branch".into(),
                    "--ahead-behind".into(),
                    "-z".into(),
                    "--untracked-files=all".into(),
                    "--ignore-submodules=dirty".into(),
                ],
                false,
            )
            .await?;
        let mut state = parse::working_state(&bytes)?;
        for file in &state.files {
            validate_path(&file.path)?;
            if let Some(old) = &file.old_path {
                validate_path(old)?;
            }
        }
        state.operation = operation_state(repo)?;
        Ok(state)
    }

    pub async fn commit_detail(
        &self,
        repo: &Repository,
        revision: &str,
        request_id: &str,
        parent: Option<&str>,
    ) -> Result<CommitDetail> {
        self.commit_detail_with_mailmap(repo, revision, request_id, parent, true)
            .await
    }

    pub async fn commit_detail_with_mailmap(
        &self,
        repo: &Repository,
        revision: &str,
        request_id: &str,
        parent: Option<&str>,
        mailmap: bool,
    ) -> Result<CommitDetail> {
        let _scope = self.request_scope(request_id)?;
        let mut detail = self
            .commit_detail_fast_with_mailmap(repo, revision, request_id, parent, mailmap)
            .await?;
        detail.commit.refs = self
            .refs(repo, request_id)
            .await?
            .into_iter()
            .filter(|item| item.oid == detail.commit.oid)
            .collect();
        Ok(detail)
    }

    /// Detail without repository-wide decorations. Callers that already own a
    /// ref snapshot attach badges themselves; the legacy detail API above still
    /// returns decorations. Only OIDs verified here or parsed from this commit
    /// may take the internal resolved-comparison path (never frontend hashes).
    pub async fn commit_detail_fast_with_mailmap(
        &self,
        repo: &Repository,
        revision: &str,
        request_id: &str,
        parent: Option<&str>,
        mailmap: bool,
    ) -> Result<CommitDetail> {
        let _scope = self.request_scope(request_id)?;
        let oid = self.resolve_revision(repo, request_id, revision).await?;
        let detail_format = if mailmap {
            DETAIL_FORMAT_MAILMAP
        } else {
            DETAIL_FORMAT
        };
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "-c".into(),
                    "i18n.logOutputEncoding=UTF-8".into(),
                    "log".into(),
                    "-z".into(),
                    "-1".into(),
                    format!("--format={detail_format}"),
                    "--no-show-signature".into(),
                    "--no-color".into(),
                    "--no-decorate".into(),
                    "--no-notes".into(),
                    oid.clone(),
                    "--".into(),
                ],
                false,
            )
            .await?;
        let detail = parse::detail(&bytes)?;
        if detail.commit.oid != oid {
            return Err(AppError::new(
                "GIT_PARSE",
                "Commit detail returned a different object",
            ));
        }
        let base = match parent {
            Some("ROOT") => {
                if !detail.commit.parents.is_empty() {
                    return Err(argument("ROOT is only a parent of a root commit"));
                }
                None
            }
            Some(value) => {
                validate_revision(value)?;
                // A full OID is safe to reuse only after membership in the
                // freshly parsed parent list. Arbitrary frontend full hashes
                // are not existence proofs and are never globally cached.
                let value = if parse::is_full_oid(value) {
                    value.to_ascii_lowercase()
                } else {
                    self.resolve_revision(repo, request_id, value).await?
                };
                if !detail.commit.parents.contains(&value) {
                    return Err(argument("The selected base is not a parent of this commit"));
                }
                Some(value)
            }
            None => detail.commit.parents.first().cloned(),
        };
        let comparison = Comparison {
            base: base.clone().map(Side::Commit).unwrap_or(Side::Root),
            target: Side::Commit(oid.clone()),
            target_is_root: detail.commit.parents.is_empty(),
        };
        let (files, raw) = tokio::join!(
            self.compare_resolved(repo, request_id, &comparison),
            self.run_bytes(
                repo,
                request_id,
                vec!["cat-file".into(), "commit".into(), oid],
                false,
            ),
        );
        // Await both siblings before propagating errors; their shared request
        // scope and cancellation token stay alive until all processes settle.
        let files = files?;
        let signed = parse::has_commit_signature(&raw?)?;
        Ok(CommitDetail {
            commit: detail.commit,
            body: detail.body,
            committer: detail.committer,
            committer_email: detail.committer_email,
            signature: Signature {
                status: if signed { "U" } else { "N" }.into(),
                signer: String::new(),
                key: String::new(),
            },
            files,
            base,
        })
    }

    async fn comparison(
        &self,
        repo: &Repository,
        request_id: &str,
        base: Option<&str>,
        target: &str,
    ) -> Result<Comparison> {
        let target = match target {
            "ROOT" => Side::Root,
            "INDEX" => Side::Index,
            "WORKTREE" => Side::Worktree,
            value => Side::Commit(self.resolve_revision(repo, request_id, value).await?),
        };
        if repo.bare && matches!(target, Side::Index | Side::Worktree) {
            return Err(argument(
                "A bare repository has no index/worktree comparison",
            ));
        }
        let base = match base {
            Some("ROOT") => Side::Root,
            Some("INDEX") => Side::Index,
            Some("WORKTREE") => return Err(argument("WORKTREE cannot be a comparison base")),
            Some("HEAD") => match self.optional_head(repo, request_id).await? {
                Some(oid) => Side::Commit(oid),
                None => Side::Root,
            },
            Some(value) => Side::Commit(self.resolve_revision(repo, request_id, value).await?),
            None => match target {
                Side::Index | Side::Worktree => match self.optional_head(repo, request_id).await? {
                    Some(oid) => Side::Commit(oid),
                    None => Side::Root,
                },
                _ => Side::Root,
            },
        };
        if matches!(base, Side::Index) && !matches!(target, Side::Worktree) {
            return Err(argument("INDEX is only supported as a base for WORKTREE"));
        }
        Ok(Comparison {
            base,
            target,
            target_is_root: false,
        })
    }

    async fn empty_tree(&self, repo: &Repository, request_id: &str) -> Result<String> {
        // stdin is the runner's null device. No -w: this does not write objects.
        let output = self
            .run(
                repo,
                request_id,
                vec![
                    "hash-object".into(),
                    "-t".into(),
                    "tree".into(),
                    "--stdin".into(),
                ],
                false,
            )
            .await?;
        parse_oid_line(&output)
    }

    async fn comparison_args(
        &self,
        repo: &Repository,
        request_id: &str,
        comparison: &Comparison,
        patch: bool,
        context: usize,
        paths: &[String],
    ) -> Result<Vec<String>> {
        if matches!(comparison.target, Side::Worktree) {
            self.ensure_trusted_filters(repo, request_id).await?;
            let entries = parse::index_entries(
                &self
                    .run_bytes(
                        repo,
                        request_id,
                        vec!["ls-files".into(), "--stage".into(), "-z".into()],
                        false,
                    )
                    .await?,
            )?;
            let state = if entries.iter().any(|entry| entry.mode == "160000") {
                Some(self.working_state(repo, request_id).await?)
            } else {
                None
            };
            if state.as_ref().is_some_and(|state| {
                state.files.iter().any(|file| {
                    (paths.is_empty() || paths.iter().any(|path| path == &file.path))
                        && file
                            .submodule
                            .as_ref()
                            .is_some_and(|sub| sub.modified || sub.untracked)
                })
            }) {
                return Err(AppError::new("SUBMODULE_DIRTY", "A child repository has uncommitted or untracked changes. Its parent worktree diff is incomplete; open the child repository to review those changes."));
            }
        }
        let mut args = vec![
            "-c".into(),
            "core.quotePath=true".into(),
            "diff".into(),
            "--no-ext-diff".into(),
            "--no-textconv".into(),
            "--no-color".into(),
            "--no-relative".into(),
            "--ignore-submodules=dirty".into(),
            "--submodule=short".into(),
            "--find-renames=50%".into(),
            "--src-prefix=a/".into(),
            "--dst-prefix=b/".into(),
        ];
        if patch {
            args.extend([
                "--numstat".into(),
                "-z".into(),
                "--patch".into(),
                format!("--unified={context}"),
            ]);
        } else {
            args.extend([
                "--raw".into(),
                "--numstat".into(),
                "--no-abbrev".into(),
                "-z".into(),
            ]);
        }
        if let (true, Side::Root, Side::Commit(oid)) = (
            comparison.target_is_root,
            &comparison.base,
            &comparison.target,
        ) {
            // diff-tree's documented --root mode compares to the empty tree
            // without a separate hash-object launch, including SHA-256 repos.
            args[2] = "diff-tree".into();
            args.extend([
                "--root".into(),
                "--no-commit-id".into(),
                "-r".into(),
                oid.clone(),
                "--".into(),
            ]);
            for path in paths {
                args.push(literal_pathspec(path)?);
            }
            return Ok(args);
        }
        let base = match &comparison.base {
            Side::Root => Some(self.empty_tree(repo, request_id).await?),
            Side::Commit(oid) => Some(oid.clone()),
            Side::Index => None,
            Side::Worktree => return Err(argument("Invalid comparison base")),
        };
        match &comparison.target {
            Side::Index => {
                args.push("--cached".into());
                args.push(base.ok_or_else(|| argument("Invalid INDEX base"))?);
            }
            Side::Worktree => {
                if let Some(base) = base {
                    args.push(base);
                }
            }
            Side::Commit(oid) => {
                args.push(base.ok_or_else(|| argument("A commit requires a tree base"))?);
                args.push(oid.clone());
            }
            Side::Root => {
                args.push(base.ok_or_else(|| argument("ROOT requires a tree base"))?);
                args.push(self.empty_tree(repo, request_id).await?);
            }
        }
        args.push("--".into());
        for path in paths {
            args.push(literal_pathspec(path)?);
        }
        Ok(args)
    }

    pub async fn external_diff_args(
        &self,
        repo: &Repository,
        query: &DiffQuery,
    ) -> Result<Vec<String>> {
        validate_path(&query.path)?;
        let target = if query.staged == Some(true) {
            "INDEX"
        } else {
            &query.target
        };
        let comparison = self
            .comparison(repo, &query.request_id, query.base.as_deref(), target)
            .await?;
        if matches!(comparison.target, Side::Worktree) {
            let state = self.working_state(repo, &query.request_id).await?;
            if state
                .files
                .iter()
                .any(|file| file.path == query.path && file.status == "?")
            {
                return Err(AppError::new("UNTRACKED_DIFF", "External Git difftool does not include untracked files. Use the built-in read-only preview or open the file in your editor."));
            }
        }
        let mut args = vec![
            "difftool".into(),
            "--no-prompt".into(),
            "--no-textconv".into(),
        ];
        let base = match &comparison.base {
            Side::Root => Some(self.empty_tree(repo, &query.request_id).await?),
            Side::Commit(oid) => Some(oid.clone()),
            Side::Index => None,
            Side::Worktree => return Err(argument("WORKTREE cannot be a comparison base")),
        };
        if matches!(comparison.target, Side::Index) {
            args.push("--cached".into());
        }
        if let Some(base) = base {
            args.push(base);
        }
        match comparison.target {
            Side::Commit(oid) => args.push(oid),
            Side::Root => args.push(self.empty_tree(repo, &query.request_id).await?),
            _ => {}
        }
        args.push("--".into());
        args.push(format!(":(literal){}", query.path));
        if let Some(old) = &query.old_path {
            validate_path(old)?;
            args.push(format!(":(literal){old}"));
        }
        Ok(args)
    }

    pub async fn compare(&self, repo: &Repository, q: ComparisonQuery) -> Result<Vec<ChangedFile>> {
        let comparison = self
            .comparison(repo, &q.request_id, q.base.as_deref(), &q.target)
            .await?;
        self.compare_resolved(repo, &q.request_id, &comparison)
            .await
    }

    async fn compare_resolved(
        &self,
        repo: &Repository,
        request_id: &str,
        comparison: &Comparison,
    ) -> Result<Vec<ChangedFile>> {
        let args = self
            .comparison_args(repo, request_id, comparison, false, 3, &[])
            .await?;
        let mut files = parse::diff_files(&self.run_bytes(repo, request_id, args, false).await?)?;
        for file in &files {
            validate_path(&file.path)?;
            if let Some(old) = &file.old_path {
                validate_path(old)?;
            }
        }
        match &comparison.target {
            Side::Index => {
                for file in &mut files {
                    file.staged = true;
                }
            }
            Side::Worktree => {
                let state = self.working_state(repo, request_id).await?;
                let statuses: HashMap<&str, &ChangedFile> = state
                    .files
                    .iter()
                    .map(|status| (status.path.as_str(), status))
                    .collect();
                for file in &mut files {
                    if let Some(status) = statuses.get(file.path.as_str()) {
                        file.staged = status.staged;
                        file.unstaged = status.unstaged;
                    } else {
                        file.unstaged = true;
                    }
                }
                let mut known: HashSet<String> = files.iter().map(|f| f.path.clone()).collect();
                for status in state.files {
                    if (status.status == "?" || status.status.contains('U'))
                        && known.insert(status.path.clone())
                    {
                        files.push(status);
                    }
                }
            }
            _ => {}
        }
        Ok(files)
    }

    /// Patch-first historical preview. No tree/blob-content query is issued;
    /// only an untracked worktree file needs a bounded, safely-read add patch.
    pub async fn diff_patch(&self, repo: &Repository, q: DiffQuery) -> Result<DiffResult> {
        let (context, encoding) = validate_diff_query(&q)?;
        let _scope = self.request_scope(&q.request_id)?;
        let target = if q.staged == Some(true) {
            "INDEX"
        } else {
            &q.target
        };
        let comparison = self
            .comparison(repo, &q.request_id, q.base.as_deref(), target)
            .await?;
        let (mut bytes, mut binary) = self
            .read_patch_resolved(repo, &q, &comparison, context)
            .await?;
        let mut truncated = false;
        if bytes.is_empty() && matches!(comparison.target, Side::Worktree) {
            // Do not read full tracked/unchanged contents just because the patch
            // is empty. `ls-files --others` is exact, NUL-delimited and ignores
            // user-configured diff/textconv helpers.
            let untracked = self
                .run_bytes(
                    repo,
                    &q.request_id,
                    vec![
                        "ls-files".into(),
                        "--others".into(),
                        "--exclude-standard".into(),
                        "-z".into(),
                        "--".into(),
                        literal_pathspec(&q.path)?,
                    ],
                    false,
                )
                .await?;
            if parse::literal_paths(&untracked)?
                .iter()
                .any(|path| path == &q.path)
            {
                let content = read_worktree(repo, &q.path)?;
                truncated = content.truncated;
                let text = decode_content(content.bytes.as_deref(), encoding, &mut binary);
                if binary {
                    bytes = binary_added_patch(&q.path).into_bytes();
                } else if let Some(text) = text {
                    bytes = added_patch(&q.path, &text).into_bytes();
                }
            }
        }
        limit_patch(&mut bytes, &mut truncated);
        Ok(DiffResult {
            patch: decode_bytes(&bytes, encoding),
            binary,
            truncated,
            old_content: None,
            new_content: None,
        })
    }

    /// Read only the named side. The patch and the unused side are always empty;
    /// the legacy DTO's binary/truncated flags describe this side alone.
    pub async fn content_side(
        &self,
        repo: &Repository,
        q: DiffQuery,
        side: &str,
    ) -> Result<DiffResult> {
        let (_, encoding) = validate_diff_query(&q)?;
        if !matches!(side, "old" | "new") {
            return Err(argument("Content side must be old or new"));
        }
        let _scope = self.request_scope(&q.request_id)?;
        let target = if q.staged == Some(true) {
            "INDEX"
        } else {
            &q.target
        };
        let comparison = self
            .comparison(repo, &q.request_id, q.base.as_deref(), target)
            .await?;
        let (selected, path) = if side == "old" {
            (&comparison.base, q.old_path.as_deref().unwrap_or(&q.path))
        } else {
            (&comparison.target, q.path.as_str())
        };
        let content = self
            .read_content(repo, &q.request_id, selected, path)
            .await?;
        let mut binary = content.binary;
        let text = decode_content(content.bytes.as_deref(), encoding, &mut binary);
        let (old_content, new_content) = if side == "old" {
            (if binary { None } else { text }, None)
        } else {
            (None, if binary { None } else { text })
        };
        Ok(DiffResult {
            patch: String::new(),
            binary,
            truncated: content.truncated,
            old_content,
            new_content,
        })
    }

    /// Legacy full-result API, including external diff snapshots. Keep its 2 MiB
    /// per-side limit and its empty patch when either full content is oversized.
    pub async fn diff(&self, repo: &Repository, q: DiffQuery) -> Result<DiffResult> {
        let (context, encoding) = validate_diff_query(&q)?;
        let _scope = self.request_scope(&q.request_id)?;
        let target = if q.staged == Some(true) {
            "INDEX"
        } else {
            &q.target
        };
        let comparison = self
            .comparison(repo, &q.request_id, q.base.as_deref(), target)
            .await?;
        let old_path = q.old_path.as_deref().unwrap_or(&q.path);
        let mut contents = self
            .read_contents(
                repo,
                &q.request_id,
                &[(&comparison.base, old_path), (&comparison.target, &q.path)],
            )
            .await?;
        let new = contents.pop().expect("two requested contents");
        let old = contents.pop().expect("two requested contents");
        let mut binary = old.binary || new.binary;
        let mut truncated = old.truncated || new.truncated;
        let old_content = decode_content(old.bytes.as_deref(), encoding, &mut binary);
        let new_content = decode_content(new.bytes.as_deref(), encoding, &mut binary);
        let (mut patch_bytes, patch_binary) = if truncated {
            (Vec::new(), false)
        } else {
            self.read_patch_resolved(repo, &q, &comparison, context)
                .await?
        };
        binary |= patch_binary;
        if patch_bytes.is_empty()
            && old_content.is_none()
            && new_content.is_some()
            && matches!(comparison.target, Side::Worktree)
            && !binary
            && !truncated
        {
            patch_bytes = added_patch(&q.path, new_content.as_deref().unwrap_or("")).into_bytes();
        }
        limit_patch(&mut patch_bytes, &mut truncated);
        Ok(DiffResult {
            patch: decode_bytes(&patch_bytes, encoding),
            binary,
            truncated,
            old_content: if binary { None } else { old_content },
            new_content: if binary { None } else { new_content },
        })
    }

    async fn read_patch_resolved(
        &self,
        repo: &Repository,
        q: &DiffQuery,
        comparison: &Comparison,
        context: usize,
    ) -> Result<(Vec<u8>, bool)> {
        let mut paths = vec![q.path.clone()];
        if let Some(old) = &q.old_path {
            if old != &q.path {
                paths.push(old.clone());
            }
        }
        let args = self
            .comparison_args(repo, &q.request_id, comparison, true, context, &paths)
            .await?;
        let bytes = self.run_bytes(repo, &q.request_id, args, false).await?;
        let (patch, binary) = parse::patch_with_numstat(&bytes)?;
        // Numstat is authoritative. Searching arbitrary patch text for a
        // binary marker would misclassify a normal line containing that text.
        Ok((patch.to_vec(), binary))
    }

    async fn content_source(
        &self,
        repo: &Repository,
        request_id: &str,
        side: &Side,
        path: &str,
    ) -> Result<ContentSource> {
        validate_path(path)?;
        match side {
            Side::Root => Ok(ContentSource::Ready(Content::absent())),
            Side::Worktree => read_worktree(repo, path).map(ContentSource::Ready),
            Side::Commit(oid) => {
                let bytes = self
                    .run_bytes(
                        repo,
                        request_id,
                        vec![
                            "ls-tree".into(),
                            "-z".into(),
                            "-l".into(),
                            "--full-tree".into(),
                            oid.clone(),
                            "--".into(),
                            literal_pathspec(path)?,
                        ],
                        false,
                    )
                    .await?;
                let mut entries = parse::tree_entries(&bytes)?
                    .into_iter()
                    .filter(|entry| entry.path == path);
                let Some(entry) = entries.next() else {
                    return Ok(ContentSource::Ready(Content::absent()));
                };
                if entries.next().is_some() {
                    return Err(AppError::new("GIT_PARSE", "Duplicate tree entry"));
                }
                if entry.kind == "commit" || entry.mode == "160000" {
                    return Ok(ContentSource::Ready(Content::bytes(
                        format!("Subproject commit {}\n", entry.oid).into_bytes(),
                    )));
                }
                if entry.kind != "blob" {
                    return Err(argument("Only file blobs can be opened"));
                }
                if entry.size.is_none() {
                    return Err(AppError::new("GIT_PARSE", "Missing ls-tree blob size"));
                }
                Ok(ContentSource::Blob {
                    oid: entry.oid,
                    size: entry.size,
                })
            }
            Side::Index => {
                let bytes = self
                    .run_bytes(
                        repo,
                        request_id,
                        vec![
                            "ls-files".into(),
                            "--stage".into(),
                            "-z".into(),
                            "--".into(),
                            literal_pathspec(path)?,
                        ],
                        false,
                    )
                    .await?;
                let entries = parse::index_entries(&bytes)?;
                let entry = entries
                    .iter()
                    .find(|entry| entry.path == path && entry.stage == 0)
                    .or_else(|| {
                        entries
                            .iter()
                            .find(|entry| entry.path == path && entry.stage == 2)
                    });
                let Some(entry) = entry else {
                    return Ok(ContentSource::Ready(Content::absent()));
                };
                if entry.mode == "160000" {
                    return Ok(ContentSource::Ready(Content::bytes(
                        format!("Subproject commit {}\n", entry.oid).into_bytes(),
                    )));
                }
                Ok(ContentSource::Blob {
                    oid: entry.oid.clone(),
                    size: None,
                })
            }
        }
    }

    async fn read_content(
        &self,
        repo: &Repository,
        request_id: &str,
        side: &Side,
        path: &str,
    ) -> Result<Content> {
        self.read_contents(repo, request_id, &[(side, path)])
            .await?
            .pop()
            .ok_or_else(|| AppError::new("GIT_PARSE", "Missing requested content"))
    }

    /// Resolve literal paths separately, combine only full-OID object requests.
    /// Tree sizes save a cat-file preflight; index sizes share one batch-check.
    /// Oversized blobs are never requested, and duplicate rename OIDs are read
    /// only once. All state is scoped to this request, not a stale object cache.
    async fn read_contents(
        &self,
        repo: &Repository,
        request_id: &str,
        requested: &[(&Side, &str)],
    ) -> Result<Vec<Content>> {
        let mut sources = Vec::with_capacity(requested.len());
        for (side, path) in requested {
            sources.push(self.content_source(repo, request_id, side, path).await?);
        }
        let mut unknown = Vec::new();
        let mut seen = HashSet::new();
        for source in &sources {
            if let ContentSource::Blob { oid, size: None } = source {
                if seen.insert(oid.clone()) {
                    unknown.push(oid.clone());
                }
            }
        }
        if !unknown.is_empty() {
            let bytes = self
                .run_with_input(
                    repo,
                    request_id,
                    vec!["cat-file".into(), "--batch-check".into()],
                    object_batch::batch_input(&unknown)?,
                    false,
                )
                .await?;
            let metadata = object_batch::parse_batch_check(&bytes, &unknown)?;
            let mut sizes = HashMap::new();
            for object in metadata {
                if object.kind != "blob" {
                    return Err(AppError::new("GIT_PARSE", "Only file blobs can be opened"));
                }
                sizes.insert(object.oid, object.size);
            }
            for source in &mut sources {
                if let ContentSource::Blob { oid, size } = source {
                    if size.is_none() {
                        *size = sizes.get(oid).copied();
                    }
                }
            }
        }
        let mut eligible = Vec::new();
        seen.clear();
        for source in &sources {
            if let ContentSource::Blob {
                oid,
                size: Some(size),
            } = source
            {
                if *size <= CONTENT_LIMIT && seen.insert(oid.clone()) {
                    eligible.push(oid.clone());
                }
            }
        }
        let mut objects = HashMap::new();
        if !eligible.is_empty() {
            let bytes = self
                .run_with_input(
                    repo,
                    request_id,
                    vec!["cat-file".into(), "--batch".into()],
                    object_batch::batch_input(&eligible)?,
                    false,
                )
                .await?;
            for object in object_batch::parse_batch(&bytes, &eligible, CONTENT_LIMIT)? {
                objects.insert(object.oid, object.bytes);
            }
        }
        sources
            .into_iter()
            .map(|source| match source {
                ContentSource::Ready(content) => Ok(content),
                ContentSource::Blob {
                    size: Some(size), ..
                } if size > CONTENT_LIMIT => Ok(Content::too_large()),
                ContentSource::Blob {
                    oid,
                    size: Some(size),
                } => {
                    let bytes = objects
                        .get(&oid)
                        .ok_or_else(|| AppError::new("GIT_PARSE", "Missing requested blob"))?;
                    if bytes.len() != size {
                        return Err(AppError::new(
                            "GIT_PARSE",
                            "Blob size changed or output is incomplete",
                        ));
                    }
                    Ok(Content::bytes(bytes.clone()))
                }
                ContentSource::Blob { size: None, .. } => {
                    Err(AppError::new("GIT_PARSE", "Missing requested blob size"))
                }
            })
            .collect()
    }

    pub async fn stashes(&self, repo: &Repository, request_id: &str) -> Result<Vec<Stash>> {
        // `git stash list` insists on a worktree even though reading its reflog
        // does not. A bare clone can still contain refs/stash and its reflog.
        if repo.bare {
            let tip = self
                .run(
                    repo,
                    request_id,
                    vec![
                        "rev-parse".into(),
                        "--revs-only".into(),
                        "--end-of-options".into(),
                        "refs/stash".into(),
                    ],
                    false,
                )
                .await?;
            if tip.trim().is_empty() {
                return Ok(Vec::new());
            }
            parse_oid_line(&tip)?;
            let bytes = self
                .run_bytes(
                    repo,
                    request_id,
                    vec![
                        "-c".into(),
                        "i18n.logOutputEncoding=UTF-8".into(),
                        "reflog".into(),
                        "show".into(),
                        "-z".into(),
                        "--format=tformat:%gd%x00%H%x00%gs%x00%ct".into(),
                        "--no-show-signature".into(),
                        "refs/stash".into(),
                        "--".into(),
                    ],
                    false,
                )
                .await?;
            return parse::stashes(&bytes);
        }
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "-c".into(),
                    "i18n.logOutputEncoding=UTF-8".into(),
                    "stash".into(),
                    "list".into(),
                    "-z".into(),
                    "--format=tformat:%gd%x00%H%x00%gs%x00%ct".into(),
                    "--no-show-signature".into(),
                ],
                false,
            )
            .await?;
        parse::stashes(&bytes)
    }

    pub async fn remotes(&self, repo: &Repository, request_id: &str) -> Result<Vec<Remote>> {
        // config -z is unambiguous even if a URL contains whitespace/newlines.
        // `git remote -v` is a display format and must not be split on spaces.
        let config = self.read_config(repo, request_id).await?;
        let mut result: Vec<Remote> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        for entry in config {
            let Some((name, property)) = remote_key(&entry.key) else {
                continue;
            };
            if !matches!(property, "url" | "pushurl") {
                continue;
            }
            if name.is_empty() || name.starts_with('-') || name.chars().any(char::is_control) {
                return Err(AppError::new(
                    "GIT_PARSE",
                    "Invalid remote name in repository configuration",
                ));
            }
            let index = *positions.entry(name.into()).or_insert_with(|| {
                result.push(Remote {
                    name: name.into(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                result.len() - 1
            });
            let value = entry.value.unwrap_or_default();
            if property == "url" && result[index].fetch_url.is_empty() {
                result[index].fetch_url = value;
            } else if property == "pushurl" && result[index].push_url.is_empty() {
                result[index].push_url = value;
            }
        }
        for remote in &mut result {
            if remote.push_url.is_empty() {
                remote.push_url = remote.fetch_url.clone();
            }
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    }

    async fn read_config(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<Vec<parse::ConfigEntry>> {
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                vec![
                    "config".into(),
                    "--null".into(),
                    "--list".into(),
                    "--show-scope".into(),
                    "--includes".into(),
                ],
                false,
            )
            .await?;
        parse::config(&bytes)
    }

    pub async fn repo_config(&self, repo: &Repository, request_id: &str) -> Result<RepoConfig> {
        let entries = self.read_config(repo, request_id).await?;
        let get = |key: &str, global: bool| -> String {
            entries
                .iter()
                .rev()
                .find(|entry| {
                    entry.key.eq_ignore_ascii_case(key) && (!global || entry.scope == "global")
                })
                .and_then(|entry| entry.value.clone())
                .unwrap_or_default()
        };
        let signing = entries
            .iter()
            .rev()
            .find(|entry| entry.key.eq_ignore_ascii_case("commit.gpgsign"));
        let sign_commits = match signing {
            None => false,
            Some(entry) => parse_bool(entry.value.as_deref())?,
        };
        Ok(RepoConfig {
            user_name: get("user.name", false),
            user_email: get("user.email", false),
            global_user_name: get("user.name", true),
            global_user_email: get("user.email", true),
            signing_key: get("user.signingkey", false),
            sign_commits,
        })
    }
}

fn validate_diff_query(q: &DiffQuery) -> Result<(usize, Option<&'static Encoding>)> {
    validate_path(&q.path)?;
    if let Some(old) = &q.old_path {
        validate_path(old)?;
    }
    let context = q.context.unwrap_or(3);
    if context > 10000 {
        return Err(argument("Diff context exceeds 10000 lines"));
    }
    Ok((context, content_encoding(q.encoding.as_deref())?))
}

fn limit_patch(bytes: &mut Vec<u8>, truncated: &mut bool) {
    if bytes.len() > PATCH_LIMIT {
        bytes.truncate(PATCH_LIMIT);
        *truncated = true;
    }
}

fn binary_added_patch(path: &str) -> String {
    let from = patch_path(&format!("a/{path}"));
    let to = patch_path(&format!("b/{path}"));
    format!(
        "diff --git {from} {to}\nnew file mode 100644\nBinary files /dev/null and {to} differ\n"
    )
}

fn parse_oid_line(output: &str) -> Result<String> {
    let value = output.strip_suffix('\n').unwrap_or(output);
    let value = value.strip_suffix('\r').unwrap_or(value);
    if value.len() < 40 || !parse::is_oid(value) {
        return Err(AppError::new(
            "GIT_PARSE",
            "Git did not return exactly one full object ID",
        ));
    }
    Ok(value.to_owned())
}

fn attach_refs(commits: &mut [Commit], refs: &[GitRef]) {
    let mut by_oid: HashMap<&str, Vec<GitRef>> = HashMap::new();
    for item in refs {
        by_oid.entry(&item.oid).or_default().push(item.clone());
    }
    for commit in commits {
        commit.refs = by_oid.get(commit.oid.as_str()).cloned().unwrap_or_default();
    }
}

fn remote_key(key: &str) -> Option<(&str, &str)> {
    let rest = key.strip_prefix("remote.")?;
    rest.rsplit_once('.')
}

fn parse_bool(value: Option<&str>) -> Result<bool> {
    match value {
        None => Ok(true),
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Ok(true),
            "false" | "no" | "off" | "0" | "" => Ok(false),
            _ => Err(AppError::new(
                "GIT_PARSE",
                "Invalid commit.gpgsign boolean value",
            )),
        },
    }
}

fn content_encoding(label: Option<&str>) -> Result<Option<&'static Encoding>> {
    match label.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("auto") => Ok(None),
        Some(label) => Encoding::for_label(label.as_bytes())
            .map(Some)
            .ok_or_else(|| argument(format!("Unknown file encoding: {label}"))),
    }
}

fn decode_bytes(bytes: &[u8], encoding: Option<&'static Encoding>) -> String {
    if let Some(encoding) = encoding {
        return encoding.decode(bytes).0.into_owned();
    }
    if let Some((encoding, _)) = Encoding::for_bom(bytes) {
        return encoding.decode(bytes).0.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_content(
    bytes: Option<&[u8]>,
    encoding: Option<&'static Encoding>,
    binary: &mut bool,
) -> Option<String> {
    let bytes = bytes?;
    let bom_encoding = Encoding::for_bom(bytes).map(|(encoding, _)| encoding);
    let selected = encoding.or(bom_encoding);
    let wide = selected.is_some_and(|encoding| {
        std::ptr::eq(encoding, encoding_rs::UTF_16LE)
            || std::ptr::eq(encoding, encoding_rs::UTF_16BE)
    });
    if !wide && bytes.iter().take(8192).any(|b| *b == 0) {
        *binary = true;
        return None;
    }
    Some(decode_bytes(bytes, selected))
}

fn read_worktree(repo: &Repository, relative: &str) -> Result<Content> {
    if repo.bare {
        return Err(argument("A bare repository has no worktree files"));
    }
    validate_path(relative)?;
    let root = fs::canonicalize(&repo.path).map_err(io_error)?;
    let mut candidate = root.clone();
    let parts: Vec<_> = relative.split('/').collect();
    for (index, component) in parts.iter().enumerate() {
        candidate.push(component);
        let meta = match fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Content::absent())
            }
            Err(error) => return Err(io_error(error)),
        };
        let final_component = index + 1 == parts.len();
        if meta.file_type().is_symlink() {
            if !final_component {
                return Err(argument(
                    "Reading through a worktree symlink is not allowed",
                ));
            }
            let target = fs::read_link(&candidate).map_err(io_error)?;
            let value = target
                .to_str()
                .ok_or_else(|| argument("Symlink target is not valid UTF-8"))?;
            return Ok(Content::bytes(value.as_bytes().to_vec()));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // Also reject junctions and other reparse points, not only symlinks.
            if meta.file_attributes() & 0x400 != 0 {
                return Err(argument("Reading worktree reparse points is not allowed"));
            }
        }
        let canonical = fs::canonicalize(&candidate).map_err(io_error)?;
        if !canonical.starts_with(&root) {
            return Err(argument("File resolves outside this repository"));
        }
        if !final_component && !meta.is_dir() {
            return Err(argument("A parent path is not a directory"));
        }
        if final_component {
            if meta.is_dir() {
                let marker = candidate.join(".git");
                if marker.exists() {
                    return Ok(Content::bytes(b"Subproject worktree\n".to_vec()));
                }
                return Err(argument("Directories cannot be opened as file contents"));
            }
            if !meta.is_file() {
                return Err(argument("Only regular worktree files can be read"));
            }
            if meta.len() > CONTENT_LIMIT as u64 {
                return Ok(Content::too_large());
            }
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        // Do not follow a final symlink swapped in after the metadata checks.
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&candidate).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() {
        return Err(argument("The opened worktree path is not a regular file"));
    }
    #[cfg(windows)]
    verify_opened_file(&file, &root)?;
    if meta.len() > CONTENT_LIMIT as u64 {
        return Ok(Content::too_large());
    }
    let mut bytes = Vec::new();
    file.take((CONTENT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > CONTENT_LIMIT {
        return Ok(Content::too_large());
    }
    Ok(Content::bytes(bytes))
}

#[cfg(windows)]
fn verify_opened_file(file: &File, root: &Path) -> Result<()> {
    use std::os::windows::{ffi::OsStringExt, fs::MetadataExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };
    let meta = file.metadata().map_err(io_error)?;
    if meta.file_attributes() & 0x400 != 0 {
        return Err(argument("The opened file became a reparse point"));
    }
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if length == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    if length >= buffer.len() {
        return Err(argument(
            "The opened file path exceeds the supported length",
        ));
    }
    let final_path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    if !final_path.starts_with(root) {
        return Err(argument("The opened file resolves outside this repository"));
    }
    let relative = final_path
        .strip_prefix(root)
        .map_err(|_| argument("Invalid final file path"))?;
    if relative.components().any(|part| {
        part.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".git")
    }) {
        return Err(argument(
            "The opened file resolves into Git administrative data",
        ));
    }
    Ok(())
}

fn patch_path(path: &str) -> String {
    let mut result = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'\\' => result.push_str("\\\\"),
            b'"' => result.push_str("\\\""),
            b'\n' => result.push_str("\\n"),
            b'\r' => result.push_str("\\r"),
            b'\t' => result.push_str("\\t"),
            32..=126 => result.push(char::from(byte)),
            _ => result.push_str(&format!("\\{byte:03o}")),
        }
    }
    result.push('"');
    result
}

fn added_patch(path: &str, content: &str) -> String {
    let from = patch_path(&format!("a/{path}"));
    let to = patch_path(&format!("b/{path}"));
    let lines: Vec<_> = content.split_inclusive('\n').collect();
    let mut result =
        format!("diff --git {from} {to}\nnew file mode 100644\n--- /dev/null\n+++ {to}\n");
    if !lines.is_empty() {
        result.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
        for line in lines {
            result.push('+');
            result.push_str(line);
            if !line.ends_with('\n') {
                result.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    result
}

#[derive(Debug)]
struct DateRange {
    start: i64,
    end: i64,
}

impl DateRange {
    fn parse(value: &str) -> Result<Self> {
        let (from, to) = value
            .split_once("..")
            .map(|(a, b)| (a.trim(), b.trim()))
            .unwrap_or((value, value));
        let start = date_start(from)?;
        let end = date_start(to)?
            .checked_add(86399)
            .ok_or_else(|| argument("Date is out of range"))?;
        if start > end {
            return Err(argument("Date range is reversed"));
        }
        Ok(Self { start, end })
    }
}

fn date_start(value: &str) -> Result<i64> {
    if value.len() != 10
        || !value.is_ascii()
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
    {
        return Err(argument(
            "Date search expects YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD (UTC)",
        ));
    }
    let parse = |part: &str| {
        part.parse::<i64>()
            .map_err(|_| argument("Invalid calendar date"))
    };
    let year = parse(&value[..4])?;
    let month = parse(&value[5..7])?;
    let day = parse(&value[8..])?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if !(1..=9999).contains(&year) || day < 1 || day > days {
        return Err(argument("Invalid calendar date"));
    }
    // Gregorian civil date to Unix days; no timezone-dependent locale parser.
    let adjusted = year - i64::from(month <= 2);
    let era = adjusted.div_euclid(400);
    let yoe = adjusted - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok((era * 146097 + doe - 719468) * 86400)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revisions_reject_expressions_and_options() {
        for value in [
            "HEAD",
            "refs/heads/中文",
            "refs/tags/v1.0",
            "stash@{12}",
            "abcd1234",
            &"a".repeat(64),
        ] {
            assert!(validate_revision(value).is_ok(), "{value}");
        }
        for value in [
            "",
            "-n1",
            "main",
            "HEAD~1",
            "HEAD^",
            "HEAD:path",
            "a..b",
            "refs/heads/a.lock",
            "refs/heads/.bad",
            "refs/heads/a b",
            "refs/heads/a@{1}",
            "stash@{-1}",
            "stash@{yesterday}",
        ] {
            assert!(validate_revision(value).is_err(), "{value}");
        }
    }

    #[test]
    fn literal_paths_reject_traversal_and_administration() {
        for value in ["中文 file.txt", "dir/-option", "-file", "a b/c.txt"] {
            assert!(validate_path(value).is_ok());
        }
        for value in [
            "",
            "../secret",
            "a/../x",
            "/etc/passwd",
            "C:/secret",
            "a\\b",
            ".git/config",
            "a/.GIT/config",
            "a//b",
            "file:stream",
            "a/./b",
        ] {
            assert!(validate_path(value).is_err(), "{value}");
        }
        assert_eq!(literal_pathspec("中文 file.txt").unwrap(), "中文 file.txt");
    }

    #[test]
    fn date_ranges_validate_calendar_and_utc_boundaries() {
        assert_eq!(date_start("1970-01-01").unwrap(), 0);
        assert_eq!(date_start("2000-01-01").unwrap(), 946684800);
        assert!(date_start("2024-02-29").is_ok());
        assert!(date_start("2023-02-29").is_err());
        assert!(date_start("2024-13-01").is_err());
        let range = DateRange::parse("2024-01-01..2024-01-02").unwrap();
        assert_eq!(range.end - range.start, 172799);
        assert!(DateRange::parse("2024-02-01..2024-01-01").is_err());
    }

    #[test]
    fn encoding_and_binary_detection_are_bounded() {
        let mut binary = false;
        assert!(decode_content(Some(b"abc\0def"), None, &mut binary).is_none());
        assert!(binary);
        let mut binary = false;
        assert_eq!(
            decode_content(Some(&[0xff, 0xfe, b'A', 0]), None, &mut binary).as_deref(),
            Some("A")
        );
        assert!(!binary);
        assert!(content_encoding(Some("not-an-encoding")).is_err());
    }

    #[test]
    fn untracked_patch_quotes_paths_and_missing_newline() {
        let patch = added_patch("中文\nfile.txt", "one\ntwo");
        assert!(patch.contains("@@ -0,0 +1,2 @@"));
        assert!(patch.contains("+one\n+two\n\\ No newline at end of file\n"));
        assert!(!patch.contains("中文\nfile"));
    }

    #[test]
    fn oid_output_requires_one_full_object_id() {
        assert_eq!(
            parse_oid_line(&format!("{}\n", "a".repeat(64)))
                .unwrap()
                .len(),
            64
        );
        assert!(parse_oid_line("abc\n").is_err());
        assert!(parse_oid_line(&format!("{}\n{}\n", "a".repeat(40), "b".repeat(40))).is_err());
    }
}
