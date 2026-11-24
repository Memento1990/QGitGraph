use crate::{
    error::{AppError, Result},
    git::sanitize_environment,
    model::{DiffQuery, Repository},
    state::AppState,
};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn trusted(repo: &Repository) -> Result<()> {
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before opening external tools.",
        ));
    }
    Ok(())
}
pub fn editor(state: &AppState, repo: &Repository, relative: &str) -> Result<()> {
    trusted(repo)?;
    crate::git::read::validate_path(relative)?;
    let root = std::fs::canonicalize(&repo.path).map_err(AppError::io)?;
    let file = std::fs::canonicalize(root.join(relative)).map_err(AppError::io)?;
    if !file.starts_with(root) || !file.is_file() {
        return Err(AppError::new(
            "PATH",
            "The selected file is not a regular file inside this working tree.",
        ));
    }
    launch_editor(state, repo, &file)
}
fn launch_editor(state: &AppState, repo: &Repository, file: &Path) -> Result<()> {
    let settings = crate::settings::effective(&state.persisted.lock().unwrap(), Some(&repo.id));
    let configured = settings
        .get("editorPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let executable = if configured.is_empty() {
        #[cfg(windows)]
        {
            PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32/notepad.exe")
        }
        #[cfg(not(windows))]
        {
            return Err(AppError::new(
                "EDITOR",
                "Configure an absolute editor executable path.",
            ));
        }
    } else {
        trusted_executable(configured)?
    };
    let templates = settings
        .get("editorArgs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(|| vec![serde_json::json!("{file}")]);
    let arguments = tool_arguments(&templates, &repo.path, Some(&file.to_string_lossy()))?;
    if !arguments
        .iter()
        .any(|arg| arg.contains(file.to_string_lossy().as_ref()))
    {
        return Err(AppError::new(
            "EDITOR",
            "Editor arguments must contain the {file} placeholder.",
        ));
    }
    let mut command = Command::new(executable);
    command.current_dir(&repo.path).args(arguments);
    sanitize_environment(&mut command, true, false, state.git.isolated_home());
    detached(&mut command)
}
pub fn terminal(state: &AppState, repo: &Repository) -> Result<()> {
    trusted(repo)?;
    let settings = crate::settings::effective(&state.persisted.lock().unwrap(), Some(&repo.id));
    let configured = settings
        .get("terminalPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut command = if configured.is_empty() {
        #[cfg(windows)]
        {
            let mut command = Command::new(std::env::current_exe().map_err(AppError::io)?);
            command.arg("--git-terminal-v2").arg(&repo.path).arg(
                state
                    .git
                    .isolated_home()
                    .map(PathBuf::from)
                    .unwrap_or_default(),
            );
            command
        }
        #[cfg(not(windows))]
        {
            return Err(AppError::new(
                "TERMINAL",
                "Configure an absolute terminal executable path.",
            ));
        }
    } else {
        Command::new(trusted_executable(configured)?)
    };
    let templates = settings
        .get("terminalArgs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    command.current_dir(&repo.path);
    if !configured.is_empty() {
        command.args(tool_arguments(&templates, &repo.path, None)?);
    }
    sanitize_environment(&mut command, true, true, state.git.isolated_home());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000010);
    }
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(AppError::io)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub async fn open_snapshot(
    state: &AppState,
    repo: &Repository,
    query: DiffQuery,
    side: &str,
) -> Result<()> {
    trusted(repo)?;
    if !matches!(side, "old" | "new") {
        return Err(AppError::new(
            "SNAPSHOT",
            "Choose the old or new file side.",
        ));
    }
    let result = state.git.content_side(repo, query.clone(), side).await?;
    if result.binary || result.truncated {
        return Err(AppError::new(
            "SNAPSHOT",
            "Binary or oversized content cannot be exported as a text snapshot.",
        ));
    }
    let text = if side == "old" {
        result.old_content
    } else {
        result.new_content
    }
    .ok_or_else(|| AppError::new("SNAPSHOT", "This file side does not exist."))?;
    state
        .git
        .with_repository_authorization(repo, &query.request_id, true, || {
            let directory = state
                .profile_directory
                .join("snapshots")
                .join(state.next_id("file"));
            std::fs::create_dir_all(&directory).map_err(AppError::io)?;
            let basename = Path::new(&query.path)
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("snapshot.txt"));
            let path = directory.join(basename);
            std::fs::write(&path, text).map_err(AppError::io)?;
            let mut permissions = std::fs::metadata(&path)
                .map_err(AppError::io)?
                .permissions();
            permissions.set_readonly(true);
            std::fs::set_permissions(&path, permissions).map_err(AppError::io)?;
            launch_editor(state, repo, &path)
        })
}

pub fn open_url(url: &str) -> Result<()> {
    let parsed = url::Url::parse(url).map_err(|_| AppError::new("URL", "Invalid URL."))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(AppError::new(
            "URL",
            "Only HTTP(S) links without embedded credentials may be opened.",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let verb: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let file: Vec<u16> = std::ffi::OsStr::new(parsed.as_str())
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err(AppError::new("URL", "Windows could not open the browser."));
        }
    }
    #[cfg(not(windows))]
    {
        let tool = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        detached(Command::new(tool).arg(parsed.as_str()))?;
    }
    Ok(())
}

pub async fn external_diff(state: &AppState, repo: &Repository, query: DiffQuery) -> Result<()> {
    trusted(repo)?;
    let arguments = state.git.external_diff_args(repo, &query).await?;
    state
        .git
        .run(repo, &query.request_id, arguments, true)
        .await?;
    Ok(())
}

pub fn tool_arguments(
    templates: &[serde_json::Value],
    repo: &str,
    file: Option<&str>,
) -> Result<Vec<String>> {
    if templates.len() > 32 {
        return Err(AppError::new(
            "TOOL",
            "External tools accept at most 32 arguments.",
        ));
    }
    templates.iter().map(|value|{
        let text=value.as_str().ok_or_else(||AppError::new("TOOL","Tool arguments must be strings."))?;
        if text.len()>4096||text.chars().any(char::is_control){return Err(AppError::new("TOOL","Invalid tool argument."));}
        let mut check=text.replace("{repo}", "");
        if file.is_some() { check=check.replace("{file}", "").replace("{line}", "").replace("{column}", ""); }
        if check.contains(['{','}']){return Err(AppError::new("TOOL","Unsupported tool placeholder. Editor supports {repo}, {file}, {line}, {column}; terminal supports {repo}."));}
        let mut output=text.replace("{repo}",repo);
        if let Some(file)=file {output=output.replace("{file}",file).replace("{line}","1").replace("{column}","1");}
        Ok(output)
    }).collect()
}
fn trusted_executable(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::new(
            "TOOL",
            "Configure an existing absolute executable path without shell arguments.",
        ));
    }
    #[cfg(windows)]
    if !path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
    {
        return Err(AppError::new(
            "TOOL",
            "External tools must be executable .exe files, not shell scripts.",
        ));
    }
    Ok(path)
}
fn detached(command: &mut Command) -> Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(AppError::io)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn console_entry() -> bool {
    crate::sessions::console_entry()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_are_tokens_not_shell_strings() {
        let args = tool_arguments(
            &[serde_json::json!("--wait"), serde_json::json!("{file}")],
            "C:/仓库",
            Some("C:/仓库/a & b.txt"),
        )
        .unwrap();
        assert_eq!(args[1], "C:/仓库/a & b.txt");
        assert!(tool_arguments(&[serde_json::json!("{file}")], "C:/repo", None).is_err());
    }
}
