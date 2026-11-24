//! One-shot, session-local clean capabilities. The caller holds the existing
//! common-dir transaction. Git is used only for dry-run/discovery: deletion is
//! restricted to pinned, byte-for-byte reviewed regular files, never directories.

use super::{clean_args, ensure_idle, ensure_worktree, operation_on_disk, GitService};
use crate::{
    authority::{PathIdentity, RepositoryIdentity},
    error::{AppError, Result},
    model::{ActionResult, GitAction, Repository},
};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

const MAX_FILES: usize = 1024;
const MAX_PATH_BYTES: usize = 512 * 1024;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_STORE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOKENS: usize = 32;
const TTL: Duration = Duration::from_secs(10 * 60);

fn stale() -> AppError {
    AppError::new("STALE_CLEAN_PREVIEW", "The clean preview is missing, expired, already used, cancelled, or changed. Nothing further was removed; preview again before confirming.")
}

fn unsafe_path() -> AppError {
    AppError::new("UNSAFE_CLEAN_PATH", "Clean accepts only exact regular files without links, nested repositories, administrative or special paths. No files were removed.")
}

fn limit() -> AppError {
    AppError::new("CLEAN_PREVIEW_LIMIT", "Clean preview exceeds its bounded file, path, byte or session limit. Narrow the worktree contents before previewing again; no files were removed.")
}

fn recheck_error(error: AppError) -> AppError {
    match error.code.as_str() {
        "AUTHORIZATION_CHANGED" | "CANCELLED" | "UNTRUSTED" => error,
        _ => stale(),
    }
}

fn words(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Options {
    untracked: bool,
    ignored: bool,
}

impl Options {
    fn from_action(action: &GitAction) -> Self {
        Self {
            untracked: action.include_untracked != Some(false),
            ignored: action.include_ignored == Some(true),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Listing {
    dry_run: Vec<u8>,
    paths: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct Stat {
    volume: u64,
    file: u64,
    size: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    mode: u32,
    change: (i64, i64),
}

#[derive(Debug, PartialEq, Eq)]
struct Candidate {
    path: String,
    parents: Vec<PathIdentity>,
    stat: Stat,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    identity: RepositoryIdentity,
    listing: Listing,
    files: Vec<Candidate>,
}

impl Snapshot {
    fn byte_size(&self) -> usize {
        self.files
            .iter()
            .map(|file| file.bytes.len())
            .sum::<usize>()
            + self.listing.dry_run.len()
            + self.listing.paths.iter().map(String::len).sum::<usize>()
    }
}

struct Preview {
    repository: Repository,
    epoch: u64,
    options: Options,
    request_id: String,
    cancellation: CancellationToken,
    issued: Instant,
    snapshot: Option<Snapshot>,
}

#[derive(Default)]
pub(in crate::git) struct CleanStore {
    previews: HashMap<String, Preview>,
}

impl CleanStore {
    fn prune(&mut self) {
        self.previews.retain(|_, preview| {
            preview.issued.elapsed() < TTL && !preview.cancellation.is_cancelled()
        });
    }

    fn bytes(&self) -> usize {
        self.previews
            .values()
            .filter_map(|preview| preview.snapshot.as_ref())
            .map(Snapshot::byte_size)
            .sum()
    }
}

// Reserve before the first asynchronous stage. Cancellation/epoch hooks remove
// pending entries too, so a late successful read cannot resurrect a capability.
struct Reservation {
    store: Arc<Mutex<CleanStore>>,
    token: String,
    complete: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.complete {
            self.store.lock().unwrap().previews.remove(&self.token);
        }
    }
}

impl GitService {
    pub(in crate::git) fn invalidate_clean_request(&self, request_id: &str) {
        self.clean_previews
            .lock()
            .unwrap()
            .previews
            .retain(|_, preview| preview.request_id != request_id);
    }

    pub(in crate::git) fn invalidate_clean_repository(&self, repo_id: &str) {
        self.clean_previews
            .lock()
            .unwrap()
            .previews
            .retain(|_, preview| preview.repository.id != repo_id);
    }

    pub(in crate::git) fn invalidate_all_clean_previews(&self) {
        self.clean_previews.lock().unwrap().previews.clear();
    }

    fn clean_request_token(&self, request_id: &str) -> Result<CancellationToken> {
        self.check_request(request_id)?;
        self.tasks
            .lock()
            .unwrap()
            .get(request_id)
            .cloned()
            .ok_or_else(stale)
    }

    async fn clean_listing(&self, repo: &Repository, action: &GitAction) -> Result<Listing> {
        self.check_repository_authorization(repo, &action.request_id, true)?;
        // Never execute a forced clean, even with a token: a directory pathspec
        // could otherwise sweep up a file created after the confirmation.
        let dry_run = self
            .run_bytes(repo, &action.request_id, clean_args(action)?, false)
            .await?;
        if dry_run.len() > MAX_PATH_BYTES {
            return Err(limit());
        }
        let options = Options::from_action(action);
        let mut paths = BTreeSet::new();
        let mut path_bytes = 0;
        for ignored in [false, true] {
            if ignored && !options.ignored || !ignored && !options.untracked {
                continue;
            }
            let mut args = words(&["ls-files", "--others", "--exclude-standard", "-z"]);
            if ignored {
                args.push("--ignored".into());
            }
            args.push("--".into());
            let output = self
                .run_bytes(repo, &action.request_id, args, false)
                .await?;
            if output.len() > MAX_PATH_BYTES || !output.is_empty() && output.last() != Some(&0) {
                return Err(limit());
            }
            for record in output
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
            {
                let path = std::str::from_utf8(record).map_err(|_| unsafe_path())?;
                validate_path(path.strip_suffix('/').unwrap_or(path))?;
                path_bytes += path.len();
                paths.insert(path.to_owned());
                if paths.len() > MAX_FILES || path_bytes > MAX_PATH_BYTES {
                    return Err(limit());
                }
            }
        }
        self.check_repository_authorization(repo, &action.request_id, true)?;
        Ok(Listing { dry_run, paths })
    }

    async fn clean_snapshot(&self, repo: &Repository, action: &GitAction) -> Result<Snapshot> {
        let listing = self.clean_listing(repo, action).await?;
        let cancellation = self.clean_request_token(&action.request_id)?;
        self.with_repository_authorization(repo, &action.request_id, true, || {
            let (identity, _pins) = RepositoryIdentity::capture(repo)?;
            let root = fs::canonicalize(&repo.path).map_err(AppError::io)?;
            let mut files = Vec::new();
            let mut remaining = MAX_BYTES;
            for path in &listing.paths {
                if cancellation.is_cancelled() {
                    return Err(AppError::new("CANCELLED", "Clean preview was cancelled."));
                }
                // Git reports an untracked nested repository as directory/.
                // Directories (including empty directories) are never deleted.
                if path.ends_with('/') {
                    continue;
                }
                let Some((parents, _parent_handles)) = checked_parents(&root, path)? else {
                    continue;
                };
                let full = root.join(path);
                let info = fs::symlink_metadata(&full).map_err(AppError::io)?;
                if info.is_dir() && !is_link(&info) {
                    continue;
                }
                let mut opened = open_file(&full, false)?;
                let stat = file_stat(&opened, &full)?;
                if stat.size > remaining as u64 {
                    return Err(limit());
                }
                let bytes = read_bounded(&mut opened, remaining)?;
                if file_stat(&opened, &full)? != stat || bytes.len() as u64 != stat.size {
                    return Err(stale());
                }
                remaining -= bytes.len();
                files.push(Candidate {
                    path: path.clone(),
                    parents,
                    stat,
                    bytes,
                });
            }
            Ok(Snapshot {
                identity,
                listing,
                files,
            })
        })
    }

    pub(super) async fn clean_action(
        &self,
        repo: &Repository,
        action: &GitAction,
    ) -> Result<ActionResult> {
        ensure_idle(repo)?;
        ensure_worktree(repo)?;
        clean_args(action)?;
        let preview = action.mode.as_deref() == Some("preview");
        let options = Options::from_action(action);
        if preview {
            if action.clean_preview_token.is_some() {
                return Err(AppError::new(
                    "INVALID_ACTION",
                    "A preview must not reuse a clean preview token.",
                ));
            }
            let token = random_token()?;
            let cancellation = self.clean_request_token(&action.request_id)?;
            let epoch = self.native_epoch(&repo.id);
            let mut reservation = Reservation {
                store: self.clean_previews.clone(),
                token: token.clone(),
                complete: false,
            };
            self.with_repository_authorization(repo, &action.request_id, true, || {
                let mut store = self.clean_previews.lock().unwrap();
                store.prune();
                if store.previews.len() >= MAX_TOKENS {
                    return Err(limit());
                }
                store.previews.insert(
                    token.clone(),
                    Preview {
                        repository: repo.clone(),
                        epoch,
                        options,
                        request_id: action.request_id.clone(),
                        cancellation: cancellation.clone(),
                        issued: Instant::now(),
                        snapshot: None,
                    },
                );
                Ok(())
            })?;
            let snapshot = self.clean_snapshot(repo, action).await?;
            let output = display_files("Would remove", &snapshot.files);
            self.check_repository_authorization(repo, &action.request_id, true)?;
            if self.native_epoch(&repo.id) != epoch {
                return Err(stale());
            }
            self.with_repository_authorization(repo, &action.request_id, true, || {
                let mut store = self.clean_previews.lock().unwrap();
                store.prune();
                if snapshot.byte_size() + store.bytes() > MAX_STORE_BYTES {
                    return Err(limit());
                }
                let entry = store.previews.get_mut(&token).ok_or_else(stale)?;
                if cancellation.is_cancelled() {
                    return Err(stale());
                }
                entry.snapshot = Some(snapshot);
                Ok(())
            })?;
            reservation.complete = true;
            return Ok(ActionResult {
                output,
                operation: operation_on_disk(repo)?.map(|operation| operation.name().to_owned()),
                session_id: None,
                status: Some("completed".into()),
                preview_token: Some(token),
            });
        }

        let token = action.clean_preview_token.as_deref().ok_or_else(stale)?;
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(stale());
        }
        // Consume before validating bindings or inspecting disk. A mismatched or
        // failed attempt cannot be retried later with the same confirmation.
        let mut entry = {
            let mut store = self.clean_previews.lock().unwrap();
            store.prune();
            store.previews.remove(token).ok_or_else(stale)?
        };
        if !super::super::same_repository(repo, &entry.repository)
            || repo.trusted != entry.repository.trusted
            || self.native_epoch(&repo.id) != entry.epoch
            || entry.options != options
            || entry.cancellation.is_cancelled()
        {
            return Err(stale());
        }
        self.check_repository_authorization(repo, &action.request_id, true)?;
        let snapshot = entry.snapshot.take().ok_or_else(stale)?;
        let _pins = snapshot.identity.validate(repo)?;
        let current = self
            .clean_snapshot(repo, action)
            .await
            .map_err(recheck_error)?;
        if current != snapshot {
            return Err(stale());
        }
        let root = fs::canonicalize(&repo.path).map_err(AppError::io)?;
        let cancellation = self.clean_request_token(&action.request_id)?;
        let mut deletions = self
            .with_repository_authorization(repo, &action.request_id, true, || {
                snapshot
                    .files
                    .iter()
                    .map(|candidate| Deletion::open(&root, candidate))
                    .collect::<Result<Vec<_>>>()
            })
            .map_err(recheck_error)?;
        // Re-enumerate under all Windows file/parent pins. Added paths are not
        // authorized by an unchanged directory-level dry-run display.
        let latest = self
            .clean_listing(repo, action)
            .await
            .map_err(recheck_error)?;
        if latest != snapshot.listing
            || entry.cancellation.is_cancelled()
            || self.native_epoch(&repo.id) != entry.epoch
        {
            return Err(stale());
        }
        self.with_repository_authorization(repo, &action.request_id, true, || {
            for (deletion, candidate) in deletions.iter_mut().zip(&snapshot.files) {
                deletion.verify(&root, candidate)?;
            }
            for (deletion, candidate) in deletions.into_iter().zip(&snapshot.files) {
                if cancellation.is_cancelled() || entry.cancellation.is_cancelled() {
                    return Err(AppError::new(
                        "CANCELLED",
                        "Clean was cancelled. Already removed files are not restored.",
                    ));
                }
                deletion.remove(&root, candidate)?;
            }
            Ok(())
        })
        .map_err(recheck_error)?;
        Ok(ActionResult {
            output: display_files("Removed", &snapshot.files),
            operation: None,
            session_id: None,
            status: Some("completed".into()),
            preview_token: None,
        })
    }
}

fn display_files(prefix: &str, files: &[Candidate]) -> String {
    if files.is_empty() {
        return "No eligible untracked regular files. Directories, nested repositories and links are not removed.".into();
    }
    let mut output = String::new();
    for file in files {
        output.push_str(prefix);
        output.push(' ');
        // Display only, never parsed back into an authorization or pathspec.
        output.push_str(&serde_json::to_string(&file.path).expect("String serialization"));
        output.push('\n');
    }
    output.push_str("Directories and nested repositories are preserved.\n");
    output
}

fn validate_path(path: &str) -> Result<()> {
    super::super::read::validate_path(path).map_err(|_| unsafe_path())?;
    if path.split('/').count() > 64 {
        return Err(limit());
    }
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|ch| ch.is_control() || "<>\"|?*".contains(ch))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|suffix| {
                    matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
                })
            })
        {
            return Err(unsafe_path());
        }
    }
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Reparse points (including junctions/cloud placeholders) and devices.
        metadata.file_attributes() & (0x400 | 0x40) != 0
    }
    #[cfg(not(windows))]
    false
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::io(error)),
    }
}

fn checked_parents(root: &Path, relative: &str) -> Result<Option<(Vec<PathIdentity>, Vec<File>)>> {
    validate_path(relative)?;
    let mut full = root.to_path_buf();
    let mut identities = Vec::new();
    let mut pins = Vec::new();
    let parts: Vec<_> = relative.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        full.push(part);
        let metadata = fs::symlink_metadata(&full).map_err(AppError::io)?;
        if is_link(&metadata) || !metadata.is_dir() {
            return Err(unsafe_path());
        }
        if exists(&full.join(".git"))?
            || exists(&full.join("HEAD"))?
                && full.join("objects").is_dir()
                && full.join("refs").is_dir()
        {
            return Ok(None);
        }
        let canonical = fs::canonicalize(&full).map_err(AppError::io)?;
        if !canonical.starts_with(root) || canonical != full {
            return Err(unsafe_path());
        }
        let identity = PathIdentity::directory(&full)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            };
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let pin = options.open(&full).map_err(AppError::io)?;
        if !identity.matches(&full) {
            return Err(stale());
        }
        identities.push(identity);
        pins.push(pin);
    }
    Ok(Some((identities, pins)))
}

fn open_file(path: &Path, delete: bool) -> Result<File> {
    let metadata = fs::symlink_metadata(path).map_err(AppError::io)?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err(unsafe_path());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if delete {
            // GENERIC_READ | DELETE. Deny write/rename until handle deletion.
            options
                .access_mode(0x8000_0000 | 0x0001_0000)
                .share_mode(FILE_SHARE_READ);
        } else {
            options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
        }
    }
    let _ = delete;
    options.open(path).map_err(AppError::io)
}

fn file_stat(file: &File, path: &Path) -> Result<Stat> {
    let info = file.metadata().map_err(AppError::io)?;
    let current = fs::symlink_metadata(path).map_err(AppError::io)?;
    if is_link(&info) || !info.is_file() || is_link(&current) || !current.is_file() {
        return Err(unsafe_path());
    }
    #[cfg(windows)]
    let (volume, identity, mode, change) = {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
            FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
        };
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
            return Err(AppError::io(io::Error::last_os_error()));
        }
        if information.nNumberOfLinks != 1 {
            return Err(unsafe_path());
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
        if length == 0
            || length >= buffer.len()
            || std::ffi::OsString::from_wide(&buffer[..length])
                != fs::canonicalize(path).map_err(AppError::io)?
        {
            return Err(stale());
        }
        (
            u64::from(information.dwVolumeSerialNumber),
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
            information.dwFileAttributes,
            (0, 0),
        )
    };
    #[cfg(unix)]
    let (volume, identity, mode, change) = {
        use std::os::unix::fs::MetadataExt;
        if info.dev() != current.dev()
            || info.ino() != current.ino()
            || info.nlink() != 1
            || current.nlink() != 1
        {
            return Err(unsafe_path());
        }
        (
            info.dev(),
            info.ino(),
            info.mode(),
            (info.ctime(), info.ctime_nsec()),
        )
    };
    #[cfg(not(any(windows, unix)))]
    return Err(unsafe_path());
    #[cfg(any(windows, unix))]
    Ok(Stat {
        volume,
        file: identity,
        size: info.len(),
        modified: info.modified().ok(),
        created: info.created().ok(),
        mode,
        change,
    })
}

fn read_bounded(file: &mut File, maximum: usize) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0)).map_err(AppError::io)?;
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(AppError::io)?;
    if bytes.len() > maximum {
        return Err(limit());
    }
    Ok(bytes)
}

struct Deletion {
    file: File,
    parents: Vec<PathIdentity>,
    _parent_pins: Vec<File>,
}

impl Deletion {
    fn open(root: &Path, candidate: &Candidate) -> Result<Self> {
        let (parents, pins) = checked_parents(root, &candidate.path)?.ok_or_else(stale)?;
        if parents != candidate.parents {
            return Err(stale());
        }
        let file = open_file(&root.join(&candidate.path), true)?;
        let mut deletion = Self {
            file,
            parents,
            _parent_pins: pins,
        };
        deletion.verify(root, candidate)?;
        Ok(deletion)
    }

    fn verify(&mut self, root: &Path, candidate: &Candidate) -> Result<()> {
        let (parents, _pins) = checked_parents(root, &candidate.path)?.ok_or_else(stale)?;
        if parents != self.parents || parents != candidate.parents {
            return Err(stale());
        }
        let path = root.join(&candidate.path);
        if file_stat(&self.file, &path)? != candidate.stat
            || read_bounded(&mut self.file, candidate.bytes.len())? != candidate.bytes
            || file_stat(&self.file, &path)? != candidate.stat
        {
            return Err(stale());
        }
        Ok(())
    }

    fn remove(mut self, root: &Path, candidate: &Candidate) -> Result<()> {
        self.verify(root, candidate)?;
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
            Ok(())
        }
        #[cfg(not(windows))]
        fs::remove_file(root.join(&candidate.path)).map_err(AppError::io)
    }
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        if unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        } != 0
        {
            return Err(AppError::new(
                "CLEAN_PREVIEW_UNAVAILABLE",
                "Could not initialize clean preview authentication.",
            ));
        }
    }
    #[cfg(not(windows))]
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(AppError::io)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn fixture() -> (tempfile::TempDir, GitService, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let root = directory.path().join("clean native 中文");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let path = crate::state::display_path(&fs::canonicalize(&root).unwrap());
        let service = GitService::isolated(None, home);
        let repo = Repository {
            id: path.clone(),
            path: path.clone(),
            name: "Native clean fixture".into(),
            git_dir: crate::state::display_path(&Path::new(&path).join(".git")),
            common_dir: crate::state::display_path(&Path::new(&path).join(".git")),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        service
            .run(
                &repo,
                "clean-native-init",
                words(&["init", "--quiet", "--initial-branch=main", "--template="]),
                true,
            )
            .await
            .unwrap();
        service
            .publish_native_repository(&repo, Some(RepositoryIdentity::capture(&repo).unwrap().0));
        fs::write(root.join("untracked.txt"), b"must preserve on refusal\n").unwrap();
        (directory, service, repo)
    }

    async fn action(
        service: &GitService,
        repo: &Repository,
        request: &str,
        token: Option<&str>,
    ) -> Result<ActionResult> {
        let action: GitAction = serde_json::from_value(json!({
            "repoId": repo.id, "requestId":request, "kind":"clean",
            "mode": if token.is_some() { "delete" } else { "preview" },
            "force": token.map(|_| true), "cleanPreviewToken": token,
        }))
        .unwrap();
        let _request = service.begin_request(request)?;
        let _transaction = service.repository_transaction(repo, request).await?;
        service.action(repo, action).await
    }

    #[tokio::test]
    async fn native_epoch_revoke_and_regrant_never_revives_clean_preview() {
        let (_directory, service, repo) = fixture().await;
        let epoch = service.native_epoch(&repo.id);
        let token = action(&service, &repo, "clean-native-preview", None)
            .await
            .unwrap()
            .preview_token
            .unwrap();
        let mut denied = repo.clone();
        denied.trusted = false;
        let identity = RepositoryIdentity::capture(&repo).unwrap().0;
        assert!(service.publish_native_repository(&denied, Some(identity.clone())) > epoch);
        assert!(service.clean_previews.lock().unwrap().previews.is_empty());
        let error = action(&service, &repo, "clean-native-denied", Some(&token))
            .await
            .unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "AUTHORIZATION_CHANGED" | "UNTRUSTED"
        ));
        assert!(service.publish_native_repository(&repo, Some(identity)) > epoch);
        assert_eq!(
            action(&service, &repo, "clean-native-regrant", Some(&token))
                .await
                .unwrap_err()
                .code,
            "STALE_CLEAN_PREVIEW"
        );
        assert_eq!(
            fs::read(Path::new(&repo.path).join("untracked.txt")).unwrap(),
            b"must preserve on refusal\n"
        );
        let fresh = action(&service, &repo, "clean-native-fresh-preview", None)
            .await
            .unwrap()
            .preview_token
            .unwrap();
        action(&service, &repo, "clean-native-fresh-delete", Some(&fresh))
            .await
            .unwrap();
        assert!(!Path::new(&repo.path).join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn unchanged_native_epoch_and_other_request_cancellation_preserve_clean_preview() {
        let (_directory, service, repo) = fixture().await;
        let epoch = service.native_epoch(&repo.id);
        let token = action(&service, &repo, "clean-native-preview", None)
            .await
            .unwrap()
            .preview_token
            .unwrap();
        assert_eq!(
            service.publish_native_repository(
                &repo,
                Some(RepositoryIdentity::capture(&repo).unwrap().0)
            ),
            epoch
        );
        service.cancel("unrelated-native-read");
        action(&service, &repo, "clean-native-delete", Some(&token))
            .await
            .unwrap();
        assert!(!Path::new(&repo.path).join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn expired_clean_preview_is_refused_and_pruned() {
        let (_directory, service, repo) = fixture().await;
        let token = action(&service, &repo, "clean-native-preview", None)
            .await
            .unwrap()
            .preview_token
            .unwrap();
        service
            .clean_previews
            .lock()
            .unwrap()
            .previews
            .get_mut(&token)
            .unwrap()
            .issued = Instant::now() - TTL - Duration::from_secs(1);
        assert_eq!(
            action(&service, &repo, "clean-native-expired", Some(&token))
                .await
                .unwrap_err()
                .code,
            "STALE_CLEAN_PREVIEW"
        );
        assert!(service.clean_previews.lock().unwrap().previews.is_empty());
        assert!(Path::new(&repo.path).join("untracked.txt").exists());
    }
}
