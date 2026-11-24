use crate::{
    error::{AppError, Result},
    model::Repository,
    state::display_path,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PathIdentity {
    path: PathBuf,
    volume: u64,
    file: u64,
}

fn changed() -> AppError {
    AppError::new("AUTHORIZATION_CHANGED", "Repository identity or native authorization changed. Reopen the repository and review trust before retrying. Writes are not rolled back.")
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

impl PathIdentity {
    pub(crate) fn directory(path: &Path) -> Result<Self> {
        Self::pin(path, true).map(|(_, identity)| identity)
    }

    pub(crate) fn matches(&self, path: &Path) -> bool {
        Self::directory(path).is_ok_and(|current| current == *self)
    }

    fn pin(path: &Path, directory: bool) -> Result<(File, Self)> {
        let before = fs::symlink_metadata(path).map_err(AppError::io)?;
        if is_link(&before) || before.is_dir() != directory || !directory && !before.is_file() {
            return Err(changed());
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            };
            // 子进程存活期间禁止替换目录和标记，不能仅依赖路径字符串相等。
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path).map_err(AppError::io)?;
        let info = file.metadata().map_err(AppError::io)?;
        if is_link(&info) || info.is_dir() != directory || !directory && !info.is_file() {
            return Err(changed());
        }
        let canonical = fs::canonicalize(path).map_err(AppError::io)?;
        #[cfg(windows)]
        let (volume, identity) = {
            use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::{
                GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
                FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
            };
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) }
                == 0
            {
                return Err(AppError::io(std::io::Error::last_os_error()));
            }
            let mut buffer = vec![0_u16; 32768];
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
                || std::ffi::OsString::from_wide(&buffer[..length]) != canonical
            {
                return Err(changed());
            }
            (
                u64::from(information.dwVolumeSerialNumber),
                (u64::from(information.nFileIndexHigh) << 32)
                    | u64::from(information.nFileIndexLow),
            )
        };
        #[cfg(unix)]
        let (volume, identity) = {
            use std::os::unix::fs::MetadataExt;
            (info.dev(), info.ino())
        };
        #[cfg(not(any(windows, unix)))]
        let (volume, identity) = (0, 0);
        if fs::canonicalize(path).map_err(AppError::io)? != canonical {
            return Err(changed());
        }
        Ok((
            file,
            Self {
                path: canonical,
                volume,
                file: identity,
            },
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepositoryIdentity {
    directories: Vec<PathIdentity>,
    marker: Option<(PathIdentity, Vec<u8>)>,
    common_marker: Option<(PathIdentity, Vec<u8>)>,
}

pub(crate) struct RepositoryPins {
    _files: Vec<File>,
}

fn read_marker(path: &Path, files: &mut Vec<File>) -> Result<(PathIdentity, Vec<u8>)> {
    let (file, identity) = PathIdentity::pin(path, false)?;
    if file.metadata().map_err(AppError::io)?.len() > 32784 {
        return Err(changed());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(32785)
        .read_to_end(&mut bytes)
        .map_err(AppError::io)?;
    if bytes.len() > 32784 {
        return Err(changed());
    }
    files.push(file);
    Ok((identity, bytes))
}

fn marker_target(bytes: &[u8], prefix: &str, relative_to: &Path) -> Result<PathBuf> {
    let text = std::str::from_utf8(bytes).map_err(|_| changed())?;
    let target = text
        .trim_end_matches(['\r', '\n'])
        .strip_prefix(prefix)
        .ok_or_else(changed)?;
    let target = target.trim_start_matches([' ', '\t']);
    if target.is_empty() || target.chars().any(char::is_control) {
        return Err(changed());
    }
    fs::canonicalize(relative_to.join(target)).map_err(AppError::io)
}

impl RepositoryIdentity {
    pub(crate) fn legacy_repository(path: &Path) -> Result<Self> {
        let root =
            crate::discovery::select_directory(&display_path(path), None, &mut || Ok(()))?.path;
        let git_marker = root.join(".git");
        let mut files = Vec::new();
        let (git, bare) = match fs::symlink_metadata(&git_marker) {
            Ok(info) if info.is_dir() && !is_link(&info) => {
                (fs::canonicalize(&git_marker).map_err(AppError::io)?, false)
            }
            Ok(info) if info.is_file() && !is_link(&info) => {
                let (_, bytes) = read_marker(&git_marker, &mut files)?;
                (marker_target(&bytes, "gitdir:", &root)?, false)
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && root.join("HEAD").is_file()
                    && root.join("objects").is_dir()
                    && root.join("refs").is_dir() =>
            {
                (root.clone(), true)
            }
            _ => return Err(changed()),
        };
        let common = match fs::symlink_metadata(git.join("commondir")) {
            Ok(_) => {
                let (_, bytes) = read_marker(&git.join("commondir"), &mut files)?;
                marker_target(&bytes, "", &git)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => git.clone(),
            _ => return Err(changed()),
        };
        let repo = Repository {
            id: display_path(&root),
            path: display_path(&root),
            name: String::new(),
            git_dir: display_path(&git),
            common_dir: display_path(&common),
            head: None,
            branch: None,
            trusted: false,
            bare,
        };
        Self::capture(&repo).map(|value| value.0)
    }

    pub(crate) fn capture(repo: &Repository) -> Result<(Self, RepositoryPins)> {
        let mut files = Vec::new();
        let mut directories = Vec::new();
        for path in [&repo.path, &repo.git_dir, &repo.common_dir] {
            crate::discovery::validate_native_path(path)?;
            if !Path::new(path).is_absolute() {
                return Err(changed());
            }
            let selected = crate::discovery::select_directory(path, None, &mut || Ok(()))?;
            // 原生发布时保存的是 canonical 身份，后来出现的别名不能替代它。
            if Path::new(&display_path(&selected.path)) != Path::new(path) {
                return Err(changed());
            }
            let (file, identity) = PathIdentity::pin(&selected.path, true)?;
            files.push(file);
            directories.push(identity);
        }
        let root = &directories[0].path;
        let git = &directories[1].path;
        let common = &directories[2].path;
        let git_marker = root.join(".git");
        let marker = if repo.bare {
            if root != git {
                return Err(changed());
            }
            None
        } else {
            let info = fs::symlink_metadata(&git_marker).map_err(AppError::io)?;
            if is_link(&info) {
                return Err(changed());
            }
            if info.is_dir() {
                if fs::canonicalize(&git_marker).map_err(AppError::io)? != *git {
                    return Err(changed());
                }
                None
            } else {
                let record = read_marker(&git_marker, &mut files)?;
                if marker_target(&record.1, "gitdir:", root)? != *git {
                    return Err(changed());
                }
                Some(record)
            }
        };
        let common_path = git.join("commondir");
        let common_marker = match fs::symlink_metadata(&common_path) {
            Ok(_) => {
                let record = read_marker(&common_path, &mut files)?;
                if marker_target(&record.1, "", git)? != *common {
                    return Err(changed());
                }
                Some(record)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && git == common => None,
            _ => return Err(changed()),
        };
        Ok((
            Self {
                directories,
                marker,
                common_marker,
            },
            RepositoryPins { _files: files },
        ))
    }

    pub(crate) fn validate(&self, repo: &Repository) -> Result<RepositoryPins> {
        let (current, pins) = Self::capture(repo)?;
        if current != *self {
            return Err(changed());
        }
        Ok(pins)
    }
}
