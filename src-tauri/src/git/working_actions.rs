//! Bounded working-tree mutations. The caller owns the common-dir transaction
//! for the whole request; this module never reacquires it. All path-bearing Git
//! writes explicitly opt into literal, NUL-delimited pathspecs, even though the
//! runner only sets GIT_LITERAL_PATHSPECS for reads.

use super::{actions, parse, read, GitService};
use crate::{
    error::{AppError, Result},
    model::{ActionResult, ChangedFile, GitAction, Repository, WorkingAction, WorkingState},
};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 1024;
const MAX_PATH_BYTES: usize = 512 * 1024;
const MAX_MESSAGE: usize = 64 * 1024;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("INVALID_WORKING_ACTION", message)
}

fn stale(message: impl Into<String>) -> AppError {
    AppError::new("STALE_WORKING_STATE", message)
}

fn words(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[derive(Debug)]
struct IndexEntry {
    path: String,
    mode: String,
    oid: String,
    stage: u8,
}

type TreeEntries = HashMap<String, (String, String)>;

fn is_gitlink(path: &str, entries: &[IndexEntry], originals: &TreeEntries) -> bool {
    entries
        .iter()
        .any(|entry| entry.path == path && entry.mode == "160000")
        || originals
            .get(path)
            .is_some_and(|(mode, _)| mode == "160000")
}

fn index_entries(bytes: &[u8]) -> Result<Vec<IndexEntry>> {
    let mut entries = Vec::new();
    for record in bytes.split(|byte| *byte == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| AppError::new("GIT_OUTPUT", "Invalid index entry."))?;
        let header = std::str::from_utf8(&record[..tab])
            .map_err(|_| AppError::new("GIT_OUTPUT", "Invalid index header."))?;
        let fields: Vec<_> = header.split(' ').collect();
        if fields.len() != 3
            || fields[0].len() != 6
            || !fields[0].bytes().all(|b| (b'0'..=b'7').contains(&b))
            || !parse::is_oid(fields[1])
            || !matches!(fields[2], "0" | "1" | "2" | "3")
        {
            return Err(AppError::new("GIT_OUTPUT", "Invalid index metadata."));
        }
        let path = std::str::from_utf8(&record[tab + 1..])
            .map_err(|_| invalid("Index paths must be valid UTF-8."))?;
        entries.push(IndexEntry {
            path: path.to_owned(),
            mode: fields[0].to_owned(),
            oid: fields[1].to_owned(),
            stage: fields[2].as_bytes()[0] - b'0',
        });
    }
    Ok(entries)
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn optional_metadata(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(error)),
    }
}

/// Validate every existing component, not just a lexical prefix. In particular,
/// never traverse a symlink/junction, nested repository, or submodule worktree.
/// Missing paths are useful for staging deletions and restoring deleted files.
fn checked_file(root: &Path, relative: &str) -> Result<Option<Metadata>> {
    checked_target(root, relative, false)
}

fn checked_target(root: &Path, relative: &str, gitlink: bool) -> Result<Option<Metadata>> {
    read::validate_path(relative)?;
    let parts: Vec<_> = relative.split('/').collect();
    let mut candidate = root.to_path_buf();
    for (position, part) in parts.iter().enumerate() {
        candidate.push(part);
        let Some(metadata) = optional_metadata(&candidate)? else {
            return Ok(None);
        };
        if is_link(&metadata) {
            return Err(invalid(
                "Worktree links and reparse points are not writable targets.",
            ));
        }
        let canonical = fs::canonicalize(&candidate).map_err(AppError::io)?;
        let actual_relative = canonical
            .strip_prefix(root)
            .map_err(|_| invalid("The path resolves outside this worktree."))?;
        for component in actual_relative.components() {
            if component
                .as_os_str()
                .to_string_lossy()
                .trim_end_matches([' ', '.'])
                .eq_ignore_ascii_case(".git")
            {
                return Err(invalid(
                    "Git administrative paths are not writable targets.",
                ));
            }
        }
        if position + 1 == parts.len() {
            if gitlink {
                if !metadata.is_dir() {
                    return Err(invalid(
                        "A gitlink target must be an initialized child worktree.",
                    ));
                }
            } else if !metadata.is_file() {
                return Err(invalid(
                    "Select an exact regular file, not a directory or submodule.",
                ));
            }
            return Ok(Some(metadata));
        }
        if !metadata.is_dir() {
            return Err(invalid("A parent path is not a directory."));
        }
        if optional_metadata(&candidate.join(".git"))?.is_some() {
            return Err(invalid(
                "Files inside nested repositories or submodules are not writable targets.",
            ));
        }
    }
    Err(invalid("A file path is required."))
}

fn checked_git_directory(path: &Path, allowed: &[PathBuf]) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path)
        .map_err(|_| invalid("The child Git directory is missing or inaccessible."))?;
    if !allowed.iter().any(|base| canonical.starts_with(base)) {
        return Err(invalid(
            "The child Git directory escapes this repository's submodule storage.",
        ));
    }
    // Inspect the unresolved spelling too: canonicalization alone would hide a
    // junction/symlink on the way to an otherwise permitted destination.
    for component in path.ancestors() {
        let metadata = fs::symlink_metadata(component).map_err(AppError::io)?;
        if is_link(&metadata) || !metadata.is_dir() {
            return Err(invalid(
                "Child Git directories cannot traverse links or reparse points.",
            ));
        }
        if allowed.iter().any(|base| component == base) {
            break;
        }
    }
    Ok(canonical)
}

fn checked_child(
    repo: &Repository,
    root: &Path,
    relative: &str,
) -> Result<(PathBuf, PathBuf, Vec<PathBuf>)> {
    if checked_target(root, relative, true)?.is_none() {
        return Err(invalid(
            "The child worktree is not initialized; no init/update was performed.",
        ));
    }
    let child = root.join(relative);
    let marker = child.join(".git");
    let metadata = optional_metadata(&marker)?.ok_or_else(|| {
        invalid("The child worktree is not initialized; no init/update was performed.")
    })?;
    if is_link(&metadata) {
        return Err(invalid(
            "A child .git marker cannot be a link or reparse point.",
        ));
    }
    let mut allowed = Vec::new();
    let git_dir = if metadata.is_dir() {
        allowed.push(marker.clone());
        marker
    } else if metadata.is_file() && metadata.len() <= 32768 {
        let marker_text = fs::read_to_string(&marker).map_err(AppError::io)?;
        let target = marker_text
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("gitdir: ")
            .filter(|target| !target.is_empty() && !target.contains(['\r', '\n', '\0']))
            .ok_or_else(|| invalid("Invalid child Git directory marker."))?;
        for parent in [&repo.common_dir, &repo.git_dir] {
            allowed.push(
                fs::canonicalize(parent)
                    .map_err(AppError::io)?
                    .join("modules"),
            );
        }
        child.join(target)
    } else {
        return Err(invalid("Invalid child Git directory marker."));
    };
    let git_dir = checked_git_directory(&git_dir, &allowed)?;
    for name in ["HEAD", "config", "commondir"] {
        if let Some(metadata) = optional_metadata(&git_dir.join(name))? {
            if is_link(&metadata) || !metadata.is_file() {
                return Err(invalid(
                    "Child Git administrative files must be regular files.",
                ));
            }
        } else if name == "HEAD" {
            return Err(invalid("The child has no initialized HEAD."));
        }
    }
    Ok((child, git_dir, allowed))
}

fn validate_envelope(repo: &Repository, action: &WorkingAction) -> Result<()> {
    if action.repo_id != repo.id {
        return Err(invalid("This action belongs to a different repository."));
    }
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before writing files or contacting remotes.",
        ));
    }
    if repo.bare {
        return Err(AppError::new(
            "BARE_REPOSITORY",
            "Working actions require a working tree.",
        ));
    }
    let paths = matches!(
        action.kind.as_str(),
        "stage" | "unstage" | "discard" | "delete-untracked"
    );
    if !paths && !matches!(action.kind.as_str(), "commit-staged" | "sync") {
        return Err(invalid("Unknown working action; no write was performed."));
    }
    if paths {
        let files = action.files.as_deref().unwrap_or_default();
        if files.is_empty() || files.len() > MAX_FILES {
            return Err(invalid("Select between 1 and 1024 exact files; whole-repository pathspecs are not accepted."));
        }
        let mut size = 0usize;
        for file in files {
            read::validate_path(&file.path)?;
            size += file.path.len() + 1;
            if let Some(old) = &file.old_path {
                read::validate_path(old)?;
                if old == &file.path {
                    return Err(invalid("A rename must have two different paths."));
                }
                size += old.len() + 1;
            }
            if let Some(status) = &file.status {
                if status.len() > 4 || status.chars().any(char::is_control) {
                    return Err(invalid("Invalid observed file status."));
                }
            }
        }
        if size > MAX_PATH_BYTES {
            return Err(invalid("Selected paths exceed the 512 KiB request limit."));
        }
    } else if action.files.is_some() {
        return Err(invalid("Commit and sync do not accept a file selection."));
    }
    if action.message.is_some() && action.kind != "commit-staged" {
        return Err(invalid("Only commit-staged accepts a message."));
    }
    if action.confirmation.is_some()
        && !matches!(action.kind.as_str(), "discard" | "delete-untracked")
    {
        return Err(invalid(
            "This action does not accept a destructive-file confirmation.",
        ));
    }
    if action.kind != "sync" && (action.pull_mode.is_some() || action.no_fast_forward.is_some()) {
        return Err(invalid("Pull options are only supported by sync."));
    }
    if action.sign.is_some() && !matches!(action.kind.as_str(), "commit-staged" | "sync") {
        return Err(invalid(
            "This action does not create commits and cannot request signing.",
        ));
    }
    if let Some(Some(head)) = &action.expected_head {
        if !parse::is_oid(head) {
            return Err(invalid(
                "Expected HEAD must be a complete commit ID or null.",
            ));
        }
    }
    if let Some(token) = &action.expected_index {
        if !token.strip_prefix("index-v1:").is_some_and(parse::is_oid) {
            return Err(invalid(
                "Invalid index confirmation token; refresh the index first.",
            ));
        }
    }
    if action.kind == "commit-staged"
        && (action.expected_head.is_none() || action.expected_index.is_none())
    {
        return Err(AppError::new("CONFIRMATION_REQUIRED", "Review HEAD and the staged index before committing; expectedHead and expectedIndex are required."));
    }
    if action.kind == "discard" && action.confirmation.as_deref() != Some("discard") {
        return Err(AppError::new("CONFIRMATION_REQUIRED", "Discarding unstaged changes requires confirmation=discard. Staged changes will be kept."));
    }
    if action.kind == "delete-untracked" {
        let files = action.files.as_deref().unwrap_or_default();
        if files.len() != 1 || files[0].old_path.is_some() {
            return Err(invalid(
                "Delete-untracked accepts exactly one file and no old path.",
            ));
        }
        if action.confirmation.as_deref() != Some(files[0].path.as_str()) {
            return Err(AppError::new("CONFIRMATION_REQUIRED", "Confirm irreversible deletion by supplying the exact repository-relative file path."));
        }
    }
    Ok(())
}

fn selected_paths(
    action: &WorkingAction,
    state: &WorkingState,
    entries: &[IndexEntry],
    originals: &TreeEntries,
    root: &Path,
) -> Result<Vec<String>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for target in action.files.as_deref().unwrap_or_default() {
        let matching: Vec<_> = state
            .files
            .iter()
            .filter(|file| file.path == target.path)
            .filter(|file| {
                target
                    .status
                    .as_ref()
                    .is_none_or(|status| status == &file.status)
            })
            .collect();
        if matching.len() != 1 {
            return Err(stale(
                "A selected file changed or is ambiguous. Refresh before retrying.",
            ));
        }
        let file = matching[0];
        if file.submodule.is_some()
            && (!matches!(action.kind.as_str(), "stage" | "unstage")
                || !is_gitlink(&file.path, entries, originals))
        {
            return Err(invalid(
                "Only an exact tracked gitlink can be staged or unstaged in its parent.",
            ));
        }
        if file.old_path.is_some() && file.status.contains('C') {
            return Err(invalid(
                "Copied files must be selected without expanding their source path.",
            ));
        }
        if let Some(old) = &target.old_path {
            if file.old_path.as_ref() != Some(old) {
                // An unstaged filesystem rename is represented by Git as an
                // exact missing tracked file plus an exact new untracked file.
                let deletion = state.files.iter().find(|previous| previous.path == *old);
                let unstaged_pair = file.status == "?"
                    && deletion.is_some_and(|previous| {
                        previous.status.as_bytes().get(1) == Some(&b'D')
                            || previous.status.starts_with('D')
                    });
                // After editing a staged rename, similarity can fall below
                // rename detection. Pair only an explicitly supplied oldPath
                // with an actual staged deletion and actual staged addition.
                let staged_pair = file.status.starts_with('A')
                    && deletion.is_some_and(|previous| previous.status.starts_with('D'));
                if !(staged_pair || action.kind == "stage" && unstaged_pair) {
                    return Err(stale("The observed rename no longer matches Git's status."));
                }
            }
        }
        match action.kind.as_str() {
            "stage" if !file.unstaged => {
                return Err(stale("The file no longer has unstaged changes."))
            }
            "unstage" if !file.staged && file.status != ".A" => {
                return Err(stale("The file no longer has staged changes."));
            }
            "discard" => {
                if !file.unstaged || file.status == "?" {
                    return Err(invalid("Discard only restores tracked unstaged changes from the index; use confirmed single-file deletion for untracked files."));
                }
                if entries
                    .iter()
                    .any(|entry| entry.path == file.path && entry.stage != 0)
                {
                    return Err(AppError::new("UNRESOLVED_CONFLICTS", "An unmerged file has no single index version to restore. Resolve it explicitly."));
                }
            }
            _ => {}
        }
        for path in std::iter::once(file.path.as_str())
            .chain(file.old_path.as_deref().or(target.old_path.as_deref()))
        {
            read::validate_path(path)?;
            if entries.iter().any(|entry| {
                entry.mode == "160000" && path.starts_with(&format!("{}/", entry.path))
            }) || originals
                .iter()
                .any(|(name, (mode, _))| mode == "160000" && path.starts_with(&format!("{name}/")))
            {
                return Err(invalid(
                    "Files inside a gitlink belong to the child repository.",
                ));
            }
            if is_gitlink(path, entries, originals) {
                if !matches!(action.kind.as_str(), "stage" | "unstage") {
                    return Err(invalid(
                        "Discard and delete cannot change submodule worktrees.",
                    ));
                }
                // Unstage is index-only and can restore a removed gitlink, but
                // an existing directory still needs an initialized child, not
                // a placeholder that Git might silently treat as unchanged.
                let metadata = checked_target(root, path, true)?;
                if action.kind == "stage" && metadata.is_none() {
                    return Err(invalid(
                        "Initialize the child explicitly before staging its HEAD.",
                    ));
                }
                if seen.insert(path.to_owned()) {
                    paths.push(path.to_owned());
                }
                continue;
            }
            let metadata = checked_file(root, path)?;
            // A rename's source is a stage target only when its unstaged
            // deletion still needs recording: present in the index, absent on
            // disk. A recreated source may contain unrelated/private untracked
            // data; never stage it merely because it is a staged rename's oldPath.
            if action.kind == "stage"
                && path != file.path
                && (metadata.is_some() || !entries.iter().any(|entry| entry.path == path))
            {
                continue;
            }
            if action.kind == "stage"
                && metadata.is_none()
                && !entries.iter().any(|entry| entry.path == path)
            {
                continue;
            }
            // Discard is strictly destination/index-only. Even if a rename's
            // former source has since acquired a new index entry, it is a
            // separate file whose unstaged contents were not selected here.
            if action.kind == "discard"
                && (path != file.path
                    || !entries
                        .iter()
                        .any(|entry| entry.path == path && entry.stage == 0))
            {
                continue;
            }
            if seen.insert(path.to_owned()) {
                paths.push(path.to_owned());
            }
        }
    }
    if paths.is_empty() || paths.iter().map(|path| path.len() + 1).sum::<usize>() > MAX_PATH_BYTES {
        return Err(invalid("No bounded index-backed file selection remains."));
    }
    Ok(paths)
}

fn path_input(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for path in paths {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
    }
    bytes
}

impl GitService {
    /// Opaque confirmation of all index entries, conflict stages and flags.
    /// Neither ls-files nor hash-object (without -w) changes the index or object
    /// database. --debug includes intent-to-add/skip-worktree flags and stat
    /// metadata; even an intervening index refresh conservatively expires it.
    pub async fn working_index(&self, repo: &Repository, request_id: &str) -> Result<String> {
        let _request = self.request_scope(request_id)?;
        self.check_request(request_id)?;
        if repo.bare {
            return Err(AppError::new(
                "BARE_REPOSITORY",
                "A bare repository has no working index.",
            ));
        }
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                words(&["ls-files", "--stage", "-v", "--debug", "-z"]),
                false,
            )
            .await?;
        let hash = self
            .run_with_input(
                repo,
                request_id,
                words(&["hash-object", "--stdin"]),
                bytes,
                false,
            )
            .await?;
        let oid = String::from_utf8(hash)
            .map_err(|_| AppError::new("GIT_OUTPUT", "Invalid index digest."))?;
        let oid = oid.trim();
        if !parse::is_oid(oid) {
            return Err(AppError::new(
                "GIT_OUTPUT",
                "Git did not return an index digest.",
            ));
        }
        self.check_request(request_id)?;
        Ok(format!("index-v1:{oid}"))
    }

    pub async fn working_action(
        &self,
        repo: &Repository,
        action: WorkingAction,
    ) -> Result<ActionResult> {
        let _request = self.request_scope(&action.request_id)?;
        self.check_repository_authorization(repo, &action.request_id, true)?;
        validate_envelope(repo, &action)?;
        if action.kind == "sync" {
            return self.working_sync(repo, &action).await;
        }
        let state = self.working_state(repo, &action.request_id).await?;
        self.working_check_confirmation(repo, &action, &state)
            .await?;
        let output = if action.kind == "commit-staged" {
            self.working_commit(repo, &action, &state).await?
        } else if action.kind == "delete-untracked" {
            self.working_delete(repo, &action).await?
        } else {
            let entries = self.working_entries(repo, &action.request_id).await?;
            let originals = self.working_tree_entries(repo, &action, &state).await?;
            let root = fs::canonicalize(&repo.path).map_err(AppError::io)?;
            let paths = selected_paths(&action, &state, &entries, &originals, &root)?;
            let mut gitlinks = Vec::new();
            for path in &paths {
                if is_gitlink(path, &entries, &originals)
                    && (action.kind == "stage" || root.join(path).exists())
                {
                    let head = self.working_child_head(repo, &action, &root, path).await?;
                    if action.kind == "stage" {
                        if entries.iter().any(|entry| {
                            entry.path == *path
                                && entry.stage == 0
                                && entry.mode == "160000"
                                && entry.oid == head
                        }) {
                            return Err(invalid("The child HEAD is unchanged; dirty child files cannot be staged in the parent."));
                        }
                        gitlinks.push((path.clone(), head));
                    }
                }
            }
            if action.kind == "unstage" {
                self.working_unstage(repo, &action, &state, &paths, &originals)
                    .await?
            } else if action.kind == "stage" {
                self.working_stage(repo, &action, &paths, &gitlinks).await?
            } else {
                let args = words(&[
                    "--literal-pathspecs",
                    "-c",
                    "submodule.recurse=false",
                    "restore",
                    "--worktree",
                    "--no-recurse-submodules",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ]);
                self.check_request(&action.request_id)?;
                let bytes = self
                    .run_with_input(repo, &action.request_id, args, path_input(&paths), true)
                    .await?;
                String::from_utf8_lossy(&bytes).into_owned()
            }
        };
        Ok(ActionResult {
            output,
            operation: read::operation_state(repo)?,
            preview_token: None,
            session_id: None,
            status: Some("completed".into()),
        })
    }

    async fn working_child_head(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        root: &Path,
        path: &str,
    ) -> Result<String> {
        let (child, git_dir, allowed) = checked_child(repo, root, path)?;
        // The child has an independent read-only identity, never the parent's
        // trusted bit/epoch. The helper retains parent cancellation and guards.
        let child_path = crate::state::display_path(&child);
        let mut nested = Repository {
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
        let probe = self.nested_probe_service(&action.request_id)?;
        let discovered = probe
            .run(
                &nested,
                &action.request_id,
                words(&[
                    "rev-parse",
                    "--path-format=absolute",
                    "--absolute-git-dir",
                    "--git-common-dir",
                ]),
                false,
            )
            .await?;
        let directories: Vec<_> = discovered.lines().collect();
        if directories.len() != 2
            || checked_git_directory(Path::new(directories[0]), &allowed)? != git_dir
        {
            return Err(invalid("The child Git directory changed during discovery."));
        }
        checked_git_directory(Path::new(directories[1]), &allowed)?;
        nested.id = child_path;
        nested.git_dir = directories[0].into();
        nested.common_dir = directories[1].into();
        let reader = self.nested_read_service(&nested, &action.request_id)?;
        let top = reader
            .run(
                &nested,
                &action.request_id,
                words(&["rev-parse", "--show-toplevel"]),
                false,
            )
            .await?;
        if fs::canonicalize(top.trim_end_matches(['\r', '\n'])).map_err(AppError::io)? != child {
            return Err(invalid(
                "The child Git marker resolves to a different worktree.",
            ));
        }
        let head = reader
            .run(
                &nested,
                &action.request_id,
                words(&["rev-parse", "--verify", "HEAD^{commit}"]),
                false,
            )
            .await?;
        let head = head.trim();
        if !parse::is_oid(head) {
            return Err(invalid(
                "The initialized child must have an exact commit HEAD.",
            ));
        }
        Ok(head.to_owned())
    }

    async fn working_stage(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        paths: &[String],
        gitlinks: &[(String, String)],
    ) -> Result<String> {
        let regular: Vec<_> = paths
            .iter()
            .filter(|path| !gitlinks.iter().any(|(name, _)| name == *path))
            .cloned()
            .collect();
        let mut output = Vec::new();
        if !regular.is_empty() {
            output = self
                .run_with_input(
                    repo,
                    &action.request_id,
                    words(&[
                        "--literal-pathspecs",
                        "-c",
                        "submodule.recurse=false",
                        "add",
                        "--all",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ]),
                    path_input(&regular),
                    true,
                )
                .await?;
        }
        if !gitlinks.is_empty() {
            // Unlike add, index-info cannot re-read a later child HEAD or
            // recurse into its files. The parent stores exactly this snapshot.
            let mut input = Vec::new();
            for (path, head) in gitlinks {
                input.extend_from_slice(
                    format!("0 {}\t{path}\0", "0".repeat(head.len())).as_bytes(),
                );
                input.extend_from_slice(format!("160000 {head}\t{path}\0").as_bytes());
            }
            output.extend(
                self.run_with_input(
                    repo,
                    &action.request_id,
                    words(&["--literal-pathspecs", "update-index", "-z", "--index-info"]),
                    input,
                    true,
                )
                .await?,
            );
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    async fn working_tree_entries(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        state: &WorkingState,
    ) -> Result<TreeEntries> {
        let mut originals = TreeEntries::new();
        if let Some(head) = &state.head {
            let tree = self
                .run_bytes(
                    repo,
                    &action.request_id,
                    vec![
                        "ls-tree".into(),
                        "-r".into(),
                        "-z".into(),
                        "--full-tree".into(),
                        head.clone(),
                    ],
                    false,
                )
                .await?;
            for record in tree
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
            {
                let tab = record
                    .iter()
                    .position(|byte| *byte == b'\t')
                    .ok_or_else(|| AppError::new("GIT_OUTPUT", "Invalid tree entry."))?;
                let name = std::str::from_utf8(&record[tab + 1..])
                    .map_err(|_| invalid("Tree paths must be UTF-8."))?;
                let metadata = std::str::from_utf8(&record[..tab])
                    .map_err(|_| AppError::new("GIT_OUTPUT", "Invalid tree metadata."))?;
                let fields: Vec<_> = metadata.split(' ').collect();
                if fields.len() != 3 || !parse::is_oid(fields[2]) {
                    return Err(AppError::new("GIT_OUTPUT", "Invalid tree metadata."));
                }
                originals.insert(
                    name.to_owned(),
                    (fields[0].to_owned(), fields[2].to_owned()),
                );
            }
        }
        Ok(originals)
    }

    async fn working_unstage(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        state: &WorkingState,
        paths: &[String],
        originals: &TreeEntries,
    ) -> Result<String> {
        // Path-limited reset/restore cannot unstage just one side of an
        // unmerged entry on every supported Git version. --index-info replaces
        // only the explicitly listed entries (all stages), leaving both the
        // worktree and every unrelated index entry untouched, including unborn.
        for path in paths {
            if let Some((mode, _)) = originals.get(path) {
                if !matches!(mode.as_str(), "100644" | "100755" | "160000") {
                    return Err(invalid(
                        "Only regular files and gitlinks can be unstaged here.",
                    ));
                }
            }
        }
        let oid_length = if let Some(head) = &state.head {
            head.len()
        } else {
            match self
                .run(
                    repo,
                    &action.request_id,
                    words(&["rev-parse", "--show-object-format"]),
                    false,
                )
                .await?
                .trim()
            {
                "sha1" => 40,
                "sha256" => 64,
                _ => {
                    return Err(AppError::new(
                        "GIT_OUTPUT",
                        "Unknown repository object format.",
                    ))
                }
            }
        };
        let zero = "0".repeat(oid_length);
        let mut input = Vec::new();
        for path in paths {
            input.extend_from_slice(format!("0 {zero}\t{path}\0").as_bytes());
            if let Some((mode, oid)) = originals.get(path) {
                input.extend_from_slice(format!("{mode} {oid}\t{path}\0").as_bytes());
            }
        }
        self.check_request(&action.request_id)?;
        let output = self
            .run_with_input(
                repo,
                &action.request_id,
                words(&["--literal-pathspecs", "update-index", "-z", "--index-info"]),
                input,
                true,
            )
            .await?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    async fn working_entries(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<Vec<IndexEntry>> {
        let bytes = self
            .run_bytes(
                repo,
                request_id,
                words(&["ls-files", "--stage", "--full-name", "-z"]),
                false,
            )
            .await?;
        index_entries(&bytes)
    }

    async fn working_check_confirmation(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        state: &WorkingState,
    ) -> Result<()> {
        if let Some(expected) = &action.expected_head {
            if expected != &state.head {
                return Err(AppError::new(
                    "STALE_HEAD",
                    "HEAD changed since confirmation. Refresh and review before retrying.",
                ));
            }
        }
        if let Some(expected) = &action.expected_index {
            if expected != &self.working_index(repo, &action.request_id).await? {
                return Err(AppError::new("STALE_INDEX", "The index changed since confirmation. Refresh and review the staged changes before retrying."));
            }
        }
        Ok(())
    }

    async fn working_commit(
        &self,
        repo: &Repository,
        action: &WorkingAction,
        state: &WorkingState,
    ) -> Result<String> {
        let message = action
            .message
            .as_deref()
            .ok_or_else(|| invalid("A commit message is required."))?;
        if message.trim().is_empty()
            || message.len() > MAX_MESSAGE
            || message
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(invalid("A commit needs a nonempty message of at most 64 KiB without unsafe control characters."));
        }
        let entries = self.working_entries(repo, &action.request_id).await?;
        if state.conflicts != 0 || entries.iter().any(|entry| entry.stage != 0) {
            return Err(AppError::new(
                "UNRESOLVED_CONFLICTS",
                "Resolve all conflicts and stage their resolutions before committing.",
            ));
        }
        // Ordinary commit is deliberately separate from history action commit.
        // Never consume operation/squash messages or bypass continue/follow-up.
        actions::ensure_idle(repo)?;
        if optional_metadata(&Path::new(&repo.git_dir).join("SQUASH_MSG"))?.is_some() {
            return Err(AppError::new(
                "FOLLOW_UP_REQUIRED",
                "Use the explicitly confirmed operation follow-up commit to finish this squash.",
            ));
        }
        let changed = self
            .run_bytes(
                repo,
                &action.request_id,
                words(&[
                    "diff",
                    "--cached",
                    "--name-only",
                    "--no-renames",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-z",
                    "--",
                ]),
                false,
            )
            .await?;
        if changed.is_empty() {
            return Err(AppError::new(
                "NOTHING_STAGED",
                "No staged changes to commit. No files were automatically staged.",
            ));
        }
        // Recheck both confirmations immediately before Git's own index/ref
        // locks. All application writes share the caller's common-dir mutex.
        let latest = self.working_state(repo, &action.request_id).await?;
        self.working_check_confirmation(repo, action, &latest)
            .await?;
        self.check_request(&action.request_id)?;
        // Neither --all nor --include/--only: a plain commit consumes exactly
        // the existing index, never unstaged worktree contents.
        let mut args = words(&["-c", "commit.status=false", "commit", "--no-edit"]);
        args.extend(["--message".into(), message.to_owned()]);
        match action.sign {
            Some(true) => args.push("--gpg-sign".into()),
            Some(false) => args.push("--no-gpg-sign".into()),
            None => {}
        }
        self.run(repo, &action.request_id, args, true).await
    }

    async fn working_delete(&self, repo: &Repository, action: &WorkingAction) -> Result<String> {
        let target = &action.files.as_ref().unwrap()[0];
        let root = fs::canonicalize(&repo.path).map_err(AppError::io)?;
        let metadata = checked_file(&root, &target.path)?
            .ok_or_else(|| stale("The file no longer exists."))?;
        let deletion = Deletion::open(&root, &target.path, &metadata)?;
        // Reclassify while holding the transaction and, on Windows, a handle
        // denying replacement. A file staged/ignored since the dialog is not an
        // untracked deletion target, regardless of the caller's observed status.
        let latest = self.working_state(repo, &action.request_id).await?;
        let matches: Vec<&ChangedFile> = latest
            .files
            .iter()
            .filter(|file| file.path == target.path)
            .collect();
        if matches.len() != 1
            || matches[0].status != "?"
            || matches[0].staged
            || matches[0].submodule.is_some()
        {
            return Err(stale(
                "The file is no longer exactly one untracked regular file. Nothing was deleted.",
            ));
        }
        if target.status.as_ref().is_some_and(|status| status != "?") {
            return Err(stale("The observed file classification is not untracked."));
        }
        let entries = self.working_entries(repo, &action.request_id).await?;
        if entries.iter().any(|entry| {
            entry.path == target.path || target.path.starts_with(&format!("{}/", entry.path))
        }) {
            return Err(stale(
                "The deletion target is now tracked or inside a submodule.",
            ));
        }
        self.working_check_confirmation(repo, action, &latest)
            .await?;
        self.check_request(&action.request_id)?;
        self.with_repository_authorization(repo, &action.request_id, true, || {
            deletion.remove(&root, &target.path)
        })?;
        Ok(format!("Deleted untracked file: {}", target.path))
    }

    async fn working_sync(
        &self,
        repo: &Repository,
        action: &WorkingAction,
    ) -> Result<ActionResult> {
        let state = self.working_state(repo, &action.request_id).await?;
        self.working_check_confirmation(repo, action, &state)
            .await?;
        actions::ensure_idle(repo)?;
        if state.conflicts != 0 {
            return Err(AppError::new(
                "UNRESOLVED_CONFLICTS",
                "Resolve conflicts before synchronizing.",
            ));
        }
        let mode = action.pull_mode.as_deref().unwrap_or("ff-only");
        if !matches!(mode, "ff-only" | "merge" | "rebase")
            || action.no_fast_forward == Some(true) && mode != "merge"
        {
            return Err(invalid(
                "Choose ff-only, merge or rebase; noFastForward is only valid for merge.",
            ));
        }
        let mut pull: GitAction = serde_json::from_value(serde_json::json!({
            "repoId": repo.id, "requestId": action.request_id, "kind": "pull", "mode": mode,
            "sign": action.sign,
        }))
        .map_err(AppError::io)?;
        if mode == "merge" {
            pull.no_fast_forward = action.no_fast_forward;
        }
        let current = self.action_head_branch(repo, &pull).await?;
        let full = format!("refs/heads/{current}");
        let tracking = self
            .run(
                repo,
                &action.request_id,
                vec![
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)".into(),
                    "--".into(),
                    full.clone(),
                ],
                false,
            )
            .await?;
        let rows: Vec<_> = tracking
            .lines()
            .filter_map(|line| {
                let parts: Vec<_> = line.split('\0').collect();
                (parts.len() == 3 && parts[0] == full).then_some(parts)
            })
            .collect();
        if rows.len() != 1
            || rows[0][1].is_empty()
            || rows[0][1] == "."
            || !rows[0][2].starts_with("refs/heads/")
        {
            return Err(AppError::new("UPSTREAM_REQUIRED", "Configure a real remote upstream for this local branch before synchronizing. No origin or same-name branch was guessed."));
        }
        let remote = rows[0][1].to_owned();
        let destination = rows[0][2].to_owned();
        read::validate_revision(&destination)?;
        pull.remote = Some(remote.clone());
        pull.branch = Some(destination.clone());
        // Preflight *both* directions before pull can mutate local refs. The
        // existing action layer owns URL rewrites, helper/proxy rejection,
        // protocol restrictions, generated fetch refspecs and output redaction.
        self.action_remote_named(repo, &pull, &remote, false)
            .await?;
        self.action_remote_named(repo, &pull, &remote, true).await?;
        let mut result = self.action(repo, pull.clone()).await?;
        self.check_request(&action.request_id)?;
        let latest = self.working_state(repo, &action.request_id).await?;
        actions::ensure_idle(repo)?;
        if result.operation.is_some()
            || latest.operation.is_some()
            || latest.conflicts != 0
            || !latest.files.is_empty()
            || latest.branch.as_deref() != Some(current.as_str())
        {
            return Err(AppError::new("SYNC_STOPPED", "Pull finished with changed branch, operation state, conflicts or working changes. No push was attempted; inspect the preserved repository state."));
        }
        // Observe upstream changes made by hooks before push too.
        let after_tracking = self
            .run(
                repo,
                &action.request_id,
                vec![
                    "for-each-ref".into(),
                    "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)".into(),
                    "--".into(),
                    full.clone(),
                ],
                false,
            )
            .await?;
        if after_tracking != tracking {
            return Err(stale(
                "Pull completed but upstream configuration changed. No push was attempted.",
            ));
        }
        let (remote, local) = self.action_remote_named(repo, &pull, &remote, true).await?;
        self.check_request(&action.request_id)?;
        let output = self.action_write(repo, &pull, actions::push_args(&remote, local, &format!("{full}:{destination}"), None, false)).await.map_err(|mut error| {
            error.message = "Pull completed, but push failed. Integrated commits were kept; inspect the remote before retrying.".into();
            error
        })?;
        if !result.output.is_empty() && !output.is_empty() {
            result.output.push('\n');
        }
        result.output.push_str(&output);
        Ok(result)
    }
}

struct Deletion {
    file: File,
}

impl Deletion {
    fn open(root: &Path, relative: &str, before: &Metadata) -> Result<Self> {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            };
            // DELETE | FILE_READ_ATTRIBUTES; the file is never read or written.
            options
                .access_mode(0x0001_0000 | 0x80)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(root.join(relative)).map_err(AppError::io)?;
        let metadata = file.metadata().map_err(AppError::io)?;
        if !metadata.is_file() || is_link(&metadata) || !before.is_file() {
            return Err(invalid("Only an unlinked regular file can be deleted."));
        }
        let deletion = Self { file };
        deletion.verify(root, relative)?;
        Ok(deletion)
    }

    fn verify(&self, root: &Path, relative: &str) -> Result<()> {
        let current = checked_file(root, relative)?
            .ok_or_else(|| stale("The deletion target disappeared."))?;
        let opened = self.file.metadata().map_err(AppError::io)?;
        if !opened.is_file() || is_link(&opened) {
            return Err(invalid("The opened deletion target is not a regular file."));
        }
        #[cfg(windows)]
        {
            use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
                FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
            };
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                GetFileInformationByHandle(self.file.as_raw_handle() as _, &mut information)
            } == 0
            {
                return Err(AppError::io(io::Error::last_os_error()));
            }
            if information.nNumberOfLinks != 1 {
                return Err(invalid(
                    "Hard-linked files cannot be deleted through working actions.",
                ));
            }
            let mut buffer = vec![0u16; 32768];
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    self.file.as_raw_handle() as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 || length >= buffer.len() {
                return Err(invalid("Cannot verify the opened deletion path."));
            }
            let actual = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
            if actual != fs::canonicalize(root.join(relative)).map_err(AppError::io)?
                || !actual.starts_with(root)
            {
                return Err(invalid("The opened deletion target changed paths."));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if current.dev() != opened.dev()
                || current.ino() != opened.ino()
                || opened.nlink() != 1
                || current.nlink() != 1
            {
                return Err(invalid(
                    "Replaced or hard-linked files cannot be deleted through working actions.",
                ));
            }
        }
        let _ = current;
        Ok(())
    }

    fn remove(self, root: &Path, relative: &str) -> Result<()> {
        self.verify(root, relative)?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            };
            let information = FILE_DISPOSITION_INFO { DeleteFile: 1 };
            if unsafe {
                SetFileInformationByHandle(
                    self.file.as_raw_handle() as _,
                    FileDispositionInfo,
                    &information as *const _ as _,
                    std::mem::size_of_val(&information) as u32,
                )
            } == 0
            {
                return Err(AppError::io(io::Error::last_os_error()));
            }
            // Deletion applies to this verified handle, not a newly resolved
            // path. Dropping it releases the single-file delete disposition.
            Ok(())
        }
        #[cfg(not(windows))]
        fs::remove_file(root.join(relative)).map_err(AppError::io)
    }
}
