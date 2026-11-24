use crate::{
    error::{AppError, Result},
    git::GitService,
    model::{DiscoveryWarning, RepositoryCandidate, RepositoryDiscovery, RepositoryMarker},
    state::display_path,
};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs::{self, Metadata},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_PATH_BYTES: usize = 32768;
const MAX_MARKER_BYTES: usize = MAX_PATH_BYTES + 16;
const TIME_LIMIT: &str = "DISCOVERY_TIME";
const PERMISSION_DENIED: &str = "DISCOVERY_PERMISSION";

#[derive(Clone, Copy)]
struct ScanLimits {
    candidates: usize,
    directories: usize,
    entries: usize,
    queue: usize,
    output_bytes: usize,
    budget: Duration,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            candidates: 256,
            directories: 10_000,
            entries: 50_000,
            queue: 8192,
            output_bytes: 1024 * 1024,
            budget: Duration::from_secs(30),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct DiscoveryService {
    running: Arc<AtomicBool>,
}

struct ScanGuard(Arc<AtomicBool>);

impl ScanGuard {
    fn acquire(running: Arc<AtomicBool>) -> Result<Self> {
        running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| AppError::new("BUSY", "Repository discovery is already running."))?;
        Ok(Self(running))
    }
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl DiscoveryService {
    pub(crate) async fn discover(
        &self,
        git: GitService,
        path: String,
        depth: usize,
        request_id: String,
    ) -> Result<RepositoryDiscovery> {
        let running = self.running.clone();
        tokio::task::spawn_blocking(move || {
            // Both owners live in the actual worker, not its awaiter. Aborting
            // an IPC future cannot release the singleflight slot or request
            // while a slow filesystem/UNC call is still running.
            let _request = git.begin_request(&request_id)?;
            let _flight = ScanGuard::acquire(running)?;
            scan(&path, depth, ScanLimits::default(), || {
                git.check_request(&request_id)
            })
        })
        .await
        .map_err(AppError::io)?
    }
}

pub(crate) fn validate_native_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return Err(AppError::new("PATH", "Invalid repository directory."));
    }
    Ok(())
}

fn native_path(path: &Path) -> Result<String> {
    if path.to_str().is_none() {
        return Err(AppError::new(
            "PATH",
            "Directory names must be valid Unicode.",
        ));
    }
    let path = display_path(path);
    validate_native_path(&path)?;
    Ok(path)
}

fn probe_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        AppError::new(PERMISSION_DENIED, error.to_string())
    } else {
        AppError::io(error)
    }
}

fn checked_io<T>(
    check: &mut impl FnMut() -> Result<()>,
    operation: impl FnOnce() -> io::Result<T>,
) -> Result<T> {
    check()?;
    let result = operation();
    check()?;
    result.map_err(probe_error)
}

fn metadata(path: &Path, check: &mut impl FnMut() -> Result<()>) -> Result<Option<Metadata>> {
    checked_io(check, || match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    })
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points are not all reported as symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn open_marker(
    path: &Path,
    directory: &Path,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<Option<fs::File>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = checked_io(check, || options.open(path))?;
    let info = checked_io(check, || file.metadata())?;
    if is_link(&info) || !info.is_file() || info.len() > MAX_MARKER_BYTES as u64 {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
        };
        let mut buffer = vec![0_u16; MAX_PATH_BYTES];
        let length = checked_io(check, || {
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle() as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(length)
            }
        })?;
        if length >= buffer.len() {
            return Err(AppError::new(
                "PATH",
                "Repository marker path exceeds its limit.",
            ));
        }
        let actual = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        if actual.parent() != Some(directory) {
            return Ok(None);
        }
    }
    #[cfg(not(windows))]
    {
        // Revalidate metadata before any read on non-Windows too. Windows uses
        // the handle's final path and OPEN_REPARSE_POINT to close the swap gap.
        if metadata(path, check)?.is_none_or(|info| is_link(&info))
            || checked_io(check, || fs::canonicalize(path))?.parent() != Some(directory)
        {
            return Ok(None);
        }
    }
    Ok(Some(file))
}

#[derive(Default)]
struct MarkerProbe {
    marker: Option<RepositoryMarker>,
    links: usize,
}

fn marker(directory: &Path, check: &mut impl FnMut() -> Result<()>) -> Result<MarkerProbe> {
    let mut result = MarkerProbe::default();
    let git = directory.join(".git");
    if let Some(info) = metadata(&git, check)? {
        if is_link(&info) {
            result.links += 1;
        } else if info.is_dir() {
            result.marker = Some(RepositoryMarker::GitDirectory);
            return Ok(result);
        } else if info.is_file() && info.len() <= MAX_MARKER_BYTES as u64 {
            // Inspect only the marker, never its gitdir target. Worktree and
            // submodule gitfiles may legitimately point outside the scan root.
            let canonical = checked_io(check, || fs::canonicalize(&git))?;
            if canonical.parent() != Some(directory) {
                result.links += 1;
            } else if let Some(file) = open_marker(&git, directory, check)? {
                let mut bytes = Vec::new();
                checked_io(check, || {
                    file.take((MAX_MARKER_BYTES + 1) as u64)
                        .read_to_end(&mut bytes)
                })?;
                if bytes.len() <= MAX_MARKER_BYTES {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        let text = text.trim_end_matches(['\r', '\n']);
                        if text.strip_prefix("gitdir:").is_some_and(|target| {
                            let target = target.trim_start_matches([' ', '\t']);
                            !target.is_empty() && !target.chars().any(char::is_control)
                        }) {
                            result.marker = Some(RepositoryMarker::GitFile);
                            return Ok(result);
                        }
                    }
                }
            } else {
                result.links += 1;
            }
        }
    }
    // A HEAD alone (or a tracked objects directory) is not a bare repository.
    for (name, directory_kind) in [("HEAD", false), ("objects", true), ("refs", true)] {
        let Some(info) = metadata(&directory.join(name), check)? else {
            return Ok(result);
        };
        if is_link(&info) {
            result.links += 1;
            return Ok(result);
        }
        if (directory_kind && !info.is_dir()) || (!directory_kind && !info.is_file()) {
            return Ok(result);
        }
    }
    result.marker = Some(RepositoryMarker::Bare);
    Ok(result)
}

#[derive(Clone)]
pub(crate) struct SelectedDirectory {
    pub path: PathBuf,
    scope_root: Option<PathBuf>,
}

fn scoped_candidate_path(
    path: &str,
    root: &Path,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<PathBuf> {
    // The scanner emits canonical native paths (with only the display/verbatim
    // prefix removed). Unlike an explicit picker root, a cached candidate must
    // not be reinterpreted as an alias for a different repository.
    let lexical = PathBuf::from(display_path(Path::new(path)));
    let displayed_root = PathBuf::from(display_path(root));
    let relative = lexical
        .strip_prefix(&displayed_root)
        .map_err(|_| scope_error())?;
    if !lexical.is_absolute() {
        return Err(scope_error());
    }
    let mut exact = root.to_owned();
    let mut displayed_exact = displayed_root.clone();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(scope_error());
        };
        exact.push(name);
        displayed_exact.push(name);
        // Inspect the original descendant chain before canonicalizing it.
        // symlink_metadata sees junction/reparse replacements too; checking
        // only the eventual canonical path would silently turn cached A into B.
        let Some(info) = metadata(&exact, check)? else {
            return Err(candidate_error());
        };
        if is_link(&info) || !info.is_dir() {
            return Err(scope_error());
        }
    }
    // Component iteration normalizes dots/separators. Those spellings were not
    // emitted by discovery either and must not bypass the identity comparison.
    if lexical.as_os_str() != displayed_exact.as_os_str() {
        return Err(scope_error());
    }
    let canonical = checked_io(check, || fs::canonicalize(&exact))?;
    if !canonical.starts_with(root)
        || Path::new(&display_path(&canonical)).as_os_str() != lexical.as_os_str()
    {
        return Err(scope_error());
    }
    Ok(canonical)
}

/// A scope selection is an exact structural candidate, unlike an ordinary
/// repository picker selection which may be a worktree subdirectory.
pub(crate) fn select_directory(
    path: &str,
    scope_root: Option<&str>,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<SelectedDirectory> {
    validate_native_path(path)?;
    let (path, scope_root) = if let Some(root) = scope_root {
        validate_native_path(root)?;
        // Explicit root aliases are allowed; candidates returned under that
        // root are already canonical and must keep their original identity.
        let root = checked_io(check, || fs::canonicalize(root))?;
        native_path(&root)?;
        let root_info = checked_io(check, || fs::metadata(&root))?;
        if !root_info.is_dir() {
            return Err(scope_error());
        }
        let path = scoped_candidate_path(path, &root, check)?;
        (path, Some(root))
    } else {
        (checked_io(check, || fs::canonicalize(path))?, None)
    };
    native_path(&path)?;
    let info = checked_io(check, || fs::metadata(&path))?;
    if !info.is_dir() {
        return Err(AppError::new("PATH", "Choose a repository directory."));
    }
    if scope_root.is_some() && marker(&path, check)?.marker.is_none() {
        return Err(candidate_error());
    }
    Ok(SelectedDirectory { path, scope_root })
}

pub(crate) fn validate_repository_root(
    selected: &SelectedDirectory,
    selected_path: &str,
    scope_root: Option<&str>,
    reported_root: &str,
    _bare: bool,
    check: &mut impl FnMut() -> Result<()>,
) -> Result<PathBuf> {
    let canonical = checked_io(check, || fs::canonicalize(reported_root))?;
    native_path(&canonical)?;
    let info = checked_io(check, || fs::metadata(&canonical))?;
    if !info.is_dir() || !selected.path.starts_with(&canonical) {
        return Err(AppError::new(
            "REPOSITORY",
            "Git returned a repository root that does not contain the selected directory.",
        ));
    }
    let current = select_directory(selected_path, scope_root, check)?;
    if current.path != selected.path {
        return Err(scope_error());
    }
    if let Some(scope) = &selected.scope_root {
        if current.scope_root.as_ref() != Some(scope)
            || canonical != selected.path
            || !canonical.starts_with(scope)
        {
            return Err(scope_error());
        }
    }
    Ok(canonical)
}

fn candidate_error() -> AppError {
    AppError::new(
        "REPOSITORY",
        "This directory is no longer an exact repository candidate. Refresh the directory tree.",
    )
}

fn scope_error() -> AppError {
    AppError::new(
        "REPOSITORY_SCOPE",
        "The repository candidate changed or is outside the selected directory scope. Refresh the directory tree.",
    )
}

fn skip_directory(name: &str, bare: bool) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | ".vs"
            | "$recycle.bin"
            | "system volume information"
    ) || (bare
        && matches!(
            name.as_str(),
            "objects"
                | "refs"
                | "hooks"
                | "info"
                | "logs"
                | "worktrees"
                | "modules"
                | "branches"
                | "rebase-apply"
                | "rebase-merge"
                | "sequencer"
        ))
}

struct Scanner<'a, C> {
    check_cancel: &'a mut C,
    limits: ScanLimits,
    started: Instant,
    result: RepositoryDiscovery,
    warnings: BTreeMap<&'static str, usize>,
    output_bytes: usize,
}

impl<C: FnMut() -> Result<()>> Scanner<'_, C> {
    fn check(&mut self) -> Result<()> {
        (self.check_cancel)()?;
        if self.started.elapsed() >= self.limits.budget {
            return Err(AppError::new(
                TIME_LIMIT,
                "Repository discovery time budget reached.",
            ));
        }
        Ok(())
    }

    fn warning(&mut self, code: &'static str, count: usize) {
        if count > 0 {
            *self.warnings.entry(code).or_default() += count;
            self.result.complete = false;
        }
    }

    fn probe_failed(&mut self, error: AppError) -> Result<()> {
        match error.code.as_str() {
            PERMISSION_DENIED => self.warning("permission-denied", 1),
            "IO" => self.warning("io", 1),
            "PATH" => self.warning("invalid-path", 1),
            _ => return Err(error),
        }
        Ok(())
    }

    fn limited(&mut self, limit: &str) {
        self.result.complete = false;
        self.result.limit = Some(limit.into());
    }

    fn enumerate(&mut self, root: &Path, depth: usize) -> Result<()> {
        let mut pending = VecDeque::from([(root.to_owned(), 0)]);
        let mut visited = HashSet::new();
        while let Some((directory, level)) = pending.pop_front() {
            self.check()?;
            if self.result.directories >= self.limits.directories {
                self.limited("directories");
                break;
            }
            let validated = (|| {
                let Some(info) = metadata(&directory, &mut || self.check())? else {
                    self.warning("io", 1);
                    return Ok(None);
                };
                if is_link(&info) {
                    self.warning("link-skipped", 1);
                    return Ok(None);
                }
                if !info.is_dir() {
                    self.warning("io", 1);
                    return Ok(None);
                }
                let canonical = checked_io(&mut || self.check(), || fs::canonicalize(&directory))?;
                let Some(current) = metadata(&directory, &mut || self.check())? else {
                    self.warning("io", 1);
                    return Ok(None);
                };
                if is_link(&current) {
                    self.warning("link-skipped", 1);
                    return Ok(None);
                }
                if !canonical.starts_with(root) {
                    self.warning("outside-root", 1);
                    return Ok(None);
                }
                native_path(&canonical)?;
                Ok(Some(canonical))
            })();
            let directory = match validated {
                Ok(Some(directory)) => directory,
                Ok(None) => continue,
                Err(error) => {
                    self.probe_failed(error)?;
                    continue;
                }
            };
            if !visited.insert(directory.clone()) {
                continue;
            }
            self.result.directories += 1;
            let found = match marker(&directory, &mut || self.check()) {
                Ok(found) => found,
                Err(error) => {
                    self.probe_failed(error)?;
                    // A failed marker probe must not hide otherwise readable
                    // descendants of a directory.
                    MarkerProbe::default()
                }
            };
            self.warning("link-skipped", found.links);
            let bare = found.marker == Some(RepositoryMarker::Bare);
            if let Some(marker) = found.marker {
                let components = directory
                    .strip_prefix(root)
                    .expect("validated containment")
                    .components()
                    .map(|component| component.as_os_str().to_str().unwrap().to_owned())
                    .collect();
                let candidate = RepositoryCandidate {
                    path: native_path(&directory)?,
                    components,
                    marker,
                };
                let bytes = serde_json::to_vec(&candidate).map_err(AppError::io)?.len() + 1;
                if self.output_bytes + bytes > self.limits.output_bytes {
                    self.limited("output");
                    break;
                }
                self.output_bytes += bytes;
                self.result.repositories.push(candidate);
                if self.result.repositories.len() >= self.limits.candidates {
                    self.limited("candidates");
                    break;
                }
            }
            // A repository can contain other repositories. Only administrative
            // directories are pruned; finding a marker never terminates descent.
            if level >= depth {
                continue;
            }
            let current = (|| {
                let info = metadata(&directory, &mut || self.check())?;
                let canonical = checked_io(&mut || self.check(), || fs::canonicalize(&directory))?;
                Ok((info, canonical))
            })();
            match current {
                Ok((Some(info), canonical))
                    if !is_link(&info) && canonical == directory && canonical.starts_with(root) => {
                }
                Ok((Some(info), _)) if is_link(&info) => {
                    self.warning("link-skipped", 1);
                    continue;
                }
                Ok(_) => {
                    self.warning("outside-root", 1);
                    continue;
                }
                Err(error) => {
                    self.probe_failed(error)?;
                    continue;
                }
            }
            let mut entries = match checked_io(&mut || self.check(), || fs::read_dir(&directory)) {
                Ok(entries) => entries,
                Err(error) => {
                    self.probe_failed(error)?;
                    continue;
                }
            };
            loop {
                self.check()?;
                if self.result.entries >= self.limits.entries {
                    self.limited("entries");
                    return Ok(());
                }
                let next = entries.next();
                self.check()?;
                let Some(entry) = next else { break };
                self.result.entries += 1;
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        self.probe_failed(probe_error(error))?;
                        continue;
                    }
                };
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    self.warning("invalid-path", 1);
                    continue;
                };
                if skip_directory(name, bare) {
                    continue;
                }
                let path = entry.path();
                if native_path(&path).is_err() {
                    self.warning("invalid-path", 1);
                    continue;
                }
                // symlink_metadata (not DirEntry::file_type alone) also detects
                // Windows junctions and non-symlink reparse points.
                let info = match metadata(&path, &mut || self.check()) {
                    Ok(Some(info)) => info,
                    Ok(None) => {
                        self.warning("io", 1);
                        continue;
                    }
                    Err(error) => {
                        self.probe_failed(error)?;
                        continue;
                    }
                };
                if is_link(&info) {
                    self.warning("link-skipped", 1);
                    continue;
                }
                if !info.is_dir() {
                    continue;
                }
                if pending.len() >= self.limits.queue {
                    self.limited("queue");
                    return Ok(());
                }
                pending.push_back((path, level + 1));
            }
        }
        Ok(())
    }
}

fn scan(
    path: &str,
    depth: usize,
    limits: ScanLimits,
    mut check_cancel: impl FnMut() -> Result<()>,
) -> Result<RepositoryDiscovery> {
    if depth > 5 {
        return Err(AppError::new(
            "DEPTH",
            "Repository discovery is limited to five directory levels.",
        ));
    }
    check_cancel()?;
    validate_native_path(path)?;
    let started = Instant::now();
    // Canonicalization of an explicitly selected root is allowed. Descendants
    // are independently revalidated before enumeration and never follow links.
    let root = checked_io(&mut check_cancel, || fs::canonicalize(path))?;
    let result = RepositoryDiscovery {
        root: native_path(&root)?,
        repositories: Vec::new(),
        complete: true,
        limit: None,
        warnings: Vec::new(),
        directories: 0,
        entries: 0,
    };
    // Reserve more than the maximum final warning/limit/counter overhead. Each
    // candidate is measured as serialized JSON (including escaped paths), not
    // as its unescaped filesystem byte length.
    let output_bytes = serde_json::to_vec(&result).map_err(AppError::io)?.len() + 1024;
    let mut scanner = Scanner {
        check_cancel: &mut check_cancel,
        limits,
        started,
        result,
        warnings: BTreeMap::new(),
        output_bytes,
    };
    let outcome = (|| {
        let info = checked_io(&mut || scanner.check(), || fs::metadata(&root))?;
        if !info.is_dir() {
            return Err(AppError::new(
                "PATH",
                "Choose a directory to discover repositories.",
            ));
        }
        scanner.enumerate(&root, depth)
    })();
    match outcome {
        Ok(()) => {}
        Err(error) if error.code == TIME_LIMIT => scanner.limited("time"),
        Err(error) if error.code == PERMISSION_DENIED => scanner.warning("permission-denied", 1),
        Err(error) => return Err(error),
    }
    (scanner.check_cancel)()?;
    scanner.result.repositories.sort_by(|a, b| {
        a.components
            .cmp(&b.components)
            .then_with(|| a.path.cmp(&b.path))
    });
    scanner.result.warnings = scanner
        .warnings
        .into_iter()
        .map(|(code, count)| DiscoveryWarning {
            code: code.into(),
            count,
        })
        .collect();
    debug_assert!(serde_json::to_vec(&scanner.result).unwrap().len() <= limits.output_bytes);
    Ok(scanner.result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(path: &Path) {
        fs::create_dir_all(path.join(".git")).unwrap();
    }

    fn discover(path: &Path, depth: usize) -> RepositoryDiscovery {
        scan(path.to_str().unwrap(), depth, ScanLimits::default(), || {
            Ok(())
        })
        .unwrap()
    }

    #[test]
    fn depth_boundaries_include_root_and_nested_repositories_without_git_or_side_effects() {
        let directory = tempfile::tempdir().unwrap();
        repository(directory.path());
        let mut nested = directory.path().to_owned();
        for name in ["one", "two", "three", "four", "five", "six"] {
            nested = nested.join(name);
            repository(&nested);
        }
        for depth in 0..=5 {
            let result = discover(directory.path(), depth);
            assert!(result.complete);
            assert_eq!(result.repositories.len(), depth + 1);
            assert_eq!(result.directories, depth + 1);
            assert_eq!(result.repositories[0].components, Vec::<String>::new());
            assert!(result
                .repositories
                .iter()
                .all(|repo| repo.components.len() <= depth));
            assert!(!directory.path().join("state.json").exists());
        }
        assert_eq!(
            scan(
                directory.path().to_str().unwrap(),
                6,
                ScanLimits::default(),
                || Ok(())
            )
            .unwrap_err()
            .code,
            "DEPTH"
        );
    }

    #[test]
    fn gitfiles_bare_repositories_and_administrative_pruning_are_structural() {
        let directory = tempfile::tempdir().unwrap();
        let worktree = directory.path().join("worktree 中文 with spaces");
        fs::create_dir(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            b"gitdir: ../outside/.git/worktrees/example\r\n",
        )
        .unwrap();
        let invalid = directory.path().join("invalid marker");
        fs::create_dir(&invalid).unwrap();
        fs::write(invalid.join(".git"), b"not a gitfile").unwrap();
        let bare = directory.path().join("bare.git");
        fs::create_dir_all(bare.join("objects")).unwrap();
        fs::create_dir_all(bare.join("refs")).unwrap();
        fs::write(bare.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        repository(&bare.join("objects/hidden"));
        repository(&bare.join("nested visible"));
        for excluded in [
            ".git",
            ".hg",
            ".svn",
            "node_modules",
            "target",
            ".vs",
            "$RECYCLE.BIN",
        ] {
            repository(&directory.path().join(excluded).join("hidden"));
        }
        // Ordinary worktrees can contain tracked directories named objects.
        repository(&worktree.join("objects/visible"));
        let result = discover(directory.path(), 5);
        assert!(result.complete);
        assert_eq!(result.repositories.len(), 5); // selected root also has .git
        assert!(result
            .repositories
            .iter()
            .any(|repo| repo.marker == RepositoryMarker::GitFile));
        assert!(result
            .repositories
            .iter()
            .any(|repo| repo.marker == RepositoryMarker::Bare));
        assert!(result
            .repositories
            .iter()
            .any(|repo| repo.components == ["worktree 中文 with spaces", "objects", "visible"]));
        assert!(!result
            .repositories
            .iter()
            .any(|repo| repo.components.iter().any(|name| name == "hidden")));
        assert!(!result
            .repositories
            .iter()
            .any(|repo| repo.components == ["invalid marker"]));
    }

    #[test]
    fn all_scan_bounds_return_honest_incomplete_results() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..8 {
            repository(&directory.path().join(format!("repo-{index}")));
        }
        for (limits, expected) in [
            (
                ScanLimits {
                    candidates: 2,
                    ..ScanLimits::default()
                },
                "candidates",
            ),
            (
                ScanLimits {
                    directories: 2,
                    ..ScanLimits::default()
                },
                "directories",
            ),
            (
                ScanLimits {
                    entries: 2,
                    ..ScanLimits::default()
                },
                "entries",
            ),
            (
                ScanLimits {
                    queue: 2,
                    ..ScanLimits::default()
                },
                "queue",
            ),
            (
                ScanLimits {
                    output_bytes: 1400,
                    ..ScanLimits::default()
                },
                "output",
            ),
            (
                ScanLimits {
                    budget: Duration::ZERO,
                    ..ScanLimits::default()
                },
                "time",
            ),
        ] {
            let result = scan(directory.path().to_str().unwrap(), 5, limits, || Ok(())).unwrap();
            assert!(!result.complete, "{expected}");
            assert_eq!(result.limit.as_deref(), Some(expected));
            assert!(result.repositories.len() <= limits.candidates);
            assert!(result.directories <= limits.directories);
            assert!(result.entries <= limits.entries);
            assert!(serde_json::to_vec(&result).unwrap().len() <= limits.output_bytes);
        }
        let defaults = ScanLimits::default();
        assert_eq!(
            (
                defaults.candidates,
                defaults.directories,
                defaults.entries,
                defaults.queue,
                defaults.output_bytes,
                defaults.budget
            ),
            (
                256,
                10_000,
                50_000,
                8192,
                1024 * 1024,
                Duration::from_secs(30)
            )
        );
    }

    #[test]
    fn cancellation_is_checked_inside_enumeration_not_only_between_directories() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..100 {
            fs::write(directory.path().join(format!("file-{index}")), b"").unwrap();
        }
        let mut checks = 0;
        let error = scan(
            directory.path().to_str().unwrap(),
            1,
            ScanLimits::default(),
            || {
                checks += 1;
                if checks >= 45 {
                    Err(AppError::new("CANCELLED", "cancelled fixture"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert_eq!(checks, 45);
    }

    #[tokio::test]
    async fn discovery_observes_registry_tombstones_and_releases_worker_owners() {
        let directory = tempfile::tempdir().unwrap();
        repository(directory.path());
        let git = GitService::new(Some(directory.path().join("not-git")));
        let service = DiscoveryService::default();
        git.cancel("pre-cancelled-scan");
        assert_eq!(
            service
                .discover(
                    git.clone(),
                    directory.path().to_string_lossy().into_owned(),
                    0,
                    "pre-cancelled-scan".into()
                )
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert!(!service.running.load(Ordering::Acquire));
        let result = service
            .discover(
                git.clone(),
                directory.path().to_string_lossy().into_owned(),
                0,
                "pre-cancelled-scan".into(),
            )
            .await
            .unwrap();
        assert_eq!(result.repositories.len(), 1);
        assert!(!service.running.load(Ordering::Acquire));
        assert!(git.active_processes("pre-cancelled-scan").is_empty());
        assert!(git.begin_request("pre-cancelled-scan").is_ok());
    }

    #[tokio::test]
    async fn aborted_awaiter_does_not_release_actual_worker_singleflight_or_request() {
        let service = DiscoveryService::default();
        let git = GitService::new(None);
        let running = service.running.clone();
        let worker_git = git.clone();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(async move {
            tokio::task::spawn_blocking(move || {
                let _request = worker_git.begin_request("blocked-scan").unwrap();
                let _flight = ScanGuard::acquire(running).unwrap();
                entered.send(()).unwrap();
                release_rx.recv().unwrap();
                worker_git.check_request("blocked-scan")
            })
            .await
            .unwrap()
        });
        entered_rx.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert_eq!(
            ScanGuard::acquire(service.running.clone())
                .err()
                .unwrap()
                .code,
            "BUSY"
        );
        assert_eq!(
            git.begin_request("blocked-scan").err().unwrap().code,
            "REQUEST"
        );
        git.cancel("blocked-scan");
        assert!(git.request_cancelled("blocked-scan"));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while service.running.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // The guards are dropped in reverse declaration order.
        tokio::time::timeout(Duration::from_secs(5), async {
            while git.begin_request("blocked-scan").is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn scoped_candidates_require_containment_current_markers_and_exact_roots() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("scope");
        let parent = root.join("parent");
        let child = parent.join("child");
        repository(&parent);
        repository(&child);
        let selected = select_directory(
            child.to_str().unwrap(),
            Some(root.to_str().unwrap()),
            &mut || Ok(()),
        )
        .unwrap();
        assert!(validate_repository_root(
            &selected,
            child.to_str().unwrap(),
            Some(root.to_str().unwrap()),
            parent.to_str().unwrap(),
            false,
            &mut || Ok(())
        )
        .is_err());
        fs::remove_dir(child.join(".git")).unwrap();
        assert_eq!(
            select_directory(
                child.to_str().unwrap(),
                Some(root.to_str().unwrap()),
                &mut || Ok(())
            )
            .err()
            .unwrap()
            .code,
            "REPOSITORY"
        );
        assert!(validate_repository_root(
            &selected,
            child.to_str().unwrap(),
            Some(root.to_str().unwrap()),
            parent.to_str().unwrap(),
            false,
            &mut || Ok(())
        )
        .is_err());
        assert_eq!(
            select_directory(
                directory.path().to_str().unwrap(),
                Some(root.to_str().unwrap()),
                &mut || Ok(())
            )
            .err()
            .unwrap()
            .code,
            "REPOSITORY_SCOPE"
        );
        // Ordinary picker selections retain subdirectory/ancestor discovery.
        let ordinary = select_directory(child.to_str().unwrap(), None, &mut || Ok(())).unwrap();
        assert!(validate_repository_root(
            &ordinary,
            child.to_str().unwrap(),
            None,
            parent.to_str().unwrap(),
            false,
            &mut || Ok(())
        )
        .is_ok());
    }

    #[cfg(any(unix, windows))]
    fn directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
            // Use a real junction even on accounts with symlink privileges, so
            // Windows tests cover non-symlink reparse points without elevation.
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(alias)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(is_link(&fs::symlink_metadata(alias).unwrap()));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn cached_scoped_candidates_reject_replacement_links_inside_and_outside_scope() {
        for outside in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("scope");
            let original = root.join("A");
            let replacement = if outside {
                directory.path().join("outside B")
            } else {
                root.join("B")
            };
            repository(&original);
            repository(&replacement);
            let result = discover(&root, 1);
            let candidate = result
                .repositories
                .iter()
                .find(|repo| repo.components == ["A"])
                .unwrap();
            let selected =
                select_directory(&candidate.path, Some(&result.root), &mut || Ok(())).unwrap();
            fs::remove_dir_all(&original).unwrap();
            directory_alias(&replacement, &original);
            assert_eq!(
                select_directory(&candidate.path, Some(&result.root), &mut || Ok(()))
                    .err()
                    .unwrap()
                    .code,
                "REPOSITORY_SCOPE",
                "outside={outside}"
            );
            assert!(validate_repository_root(
                &selected,
                &candidate.path,
                Some(&result.root),
                replacement.to_str().unwrap(),
                false,
                &mut || Ok(())
            )
            .is_err());
            // The direct picker is intentionally alias-friendly; only a cached
            // scanner candidate is required to keep its exact native identity.
            let ordinary = select_directory(&candidate.path, None, &mut || Ok(())).unwrap();
            assert_eq!(ordinary.path, fs::canonicalize(&replacement).unwrap());
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn scoped_candidates_reject_intermediate_links_but_allow_explicit_scope_root_aliases() {
        for outside in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("scope");
            let group = root.join("group");
            let original = group.join("A");
            let replacement_group = if outside {
                directory.path().join("outside group")
            } else {
                root.join("other group")
            };
            repository(&original);
            repository(&replacement_group.join("A"));
            let result = discover(&root, 2);
            let candidate = result
                .repositories
                .iter()
                .find(|repo| repo.components == ["group", "A"])
                .unwrap();
            fs::remove_dir_all(&group).unwrap();
            directory_alias(&replacement_group, &group);
            assert_eq!(
                select_directory(&candidate.path, Some(&result.root), &mut || Ok(()))
                    .err()
                    .unwrap()
                    .code,
                "REPOSITORY_SCOPE",
                "outside={outside}"
            );
            let ordinary = select_directory(&candidate.path, None, &mut || Ok(())).unwrap();
            assert_eq!(
                ordinary.path,
                fs::canonicalize(replacement_group.join("A")).unwrap()
            );
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("scope");
        repository(&root.join("A"));
        let alias = directory.path().join("scope alias");
        directory_alias(&root, &alias);
        let result = discover(&alias, 1);
        let candidate = &result.repositories[0];
        let selected =
            select_directory(&candidate.path, Some(alias.to_str().unwrap()), &mut || {
                Ok(())
            })
            .unwrap();
        assert_eq!(selected.path, fs::canonicalize(root.join("A")).unwrap());
        assert_eq!(
            select_directory(
                alias.join("A").to_str().unwrap(),
                Some(alias.to_str().unwrap()),
                &mut || Ok(())
            )
            .err()
            .unwrap()
            .code,
            "REPOSITORY_SCOPE"
        );
        assert_eq!(
            select_directory(alias.to_str().unwrap(), None, &mut || Ok(()))
                .unwrap()
                .path,
            fs::canonicalize(&root).unwrap()
        );
    }

    #[test]
    fn scoped_candidates_require_the_scanners_canonical_native_lexical_identity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("scope");
        repository(&root.join("A"));
        fs::create_dir(root.join("group")).unwrap();
        let result = discover(&root, 1);
        let candidate = &result.repositories[0];
        let canonical = fs::canonicalize(&candidate.path).unwrap();
        // Verbatim/native display prefix normalization does not create an alias.
        assert!(
            select_directory(canonical.to_str().unwrap(), Some(&result.root), &mut || Ok(
                ()
            ))
            .is_ok()
        );
        let parent_alias = Path::new(&result.root).join("group").join("..").join("A");
        assert_eq!(
            select_directory(
                parent_alias.to_str().unwrap(),
                Some(&result.root),
                &mut || Ok(())
            )
            .err()
            .unwrap()
            .code,
            "REPOSITORY_SCOPE"
        );
        let dotted_alias = format!(
            "{}{separator}.",
            candidate.path,
            separator = std::path::MAIN_SEPARATOR
        );
        assert_eq!(
            select_directory(&dotted_alias, Some(&result.root), &mut || Ok(()))
                .err()
                .unwrap()
                .code,
            "REPOSITORY_SCOPE"
        );
        assert!(select_directory(parent_alias.to_str().unwrap(), None, &mut || Ok(())).is_ok());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn descendant_links_are_skipped_and_scoped_escapes_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("scope");
        let outside = directory.path().join("outside");
        fs::create_dir(&root).unwrap();
        repository(&outside);
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        {
            if let Err(error) = std::os::windows::fs::symlink_dir(&outside, &link) {
                // Standard Windows accounts can create junctions without the
                // symbolic-link privilege; exercise that reparse case instead.
                let output = std::process::Command::new("cmd.exe")
                    .args(["/D", "/C", "mklink", "/J"])
                    .arg(&link)
                    .arg(&outside)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "symlink: {error}; junction: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        let result = discover(&root, 5);
        assert!(result.repositories.is_empty());
        assert!(!result.complete);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.code == "link-skipped" && warning.count == 1));
        assert_eq!(
            select_directory(
                link.to_str().unwrap(),
                Some(root.to_str().unwrap()),
                &mut || Ok(())
            )
            .err()
            .unwrap()
            .code,
            "REPOSITORY_SCOPE"
        );
        // A user-selected link root is canonicalized, not silently excluded.
        assert_eq!(discover(&link, 0).repositories.len(), 1);
    }

    #[test]
    fn permission_and_io_warnings_never_claim_complete_success() {
        let mut check = || Ok(());
        let mut scanner = Scanner {
            check_cancel: &mut check,
            limits: ScanLimits::default(),
            started: Instant::now(),
            result: RepositoryDiscovery {
                root: "fixture".into(),
                repositories: vec![],
                complete: true,
                limit: None,
                warnings: vec![],
                directories: 0,
                entries: 0,
            },
            warnings: BTreeMap::new(),
            output_bytes: 0,
        };
        scanner
            .probe_failed(probe_error(io::Error::from(
                io::ErrorKind::PermissionDenied,
            )))
            .unwrap();
        scanner
            .probe_failed(probe_error(io::Error::from(io::ErrorKind::NotFound)))
            .unwrap();
        assert!(!scanner.result.complete);
        assert_eq!(scanner.warnings.get("permission-denied"), Some(&1));
        assert_eq!(scanner.warnings.get("io"), Some(&1));
        assert_eq!(
            scanner
                .probe_failed(AppError::new("CANCELLED", "cancel"))
                .unwrap_err()
                .code,
            "CANCELLED"
        );
    }
}
