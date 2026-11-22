use crate::{
    error::{AppError, Result},
    git::{redact, sanitize_environment},
    model::{ExternalSession, GitAction, Repository},
    state::AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsolePlan {
    token: String,
    id: String,
    repo_id: String,
    kind: String,
    executable: PathBuf,
    shell_after: bool,
    repository: String,
    git_directory: String,
    args: Vec<String>,
    isolated_home: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct ConsoleEvent {
    token: String,
    status: String,
    code: Option<i32>,
    operation: Option<String>,
    message: String,
}

pub async fn start(
    app: &AppHandle,
    state: &AppState,
    repo: &Repository,
    action: &GitAction,
) -> Result<ExternalSession> {
    let lock = state
        .git
        .repository_transaction(repo, &action.request_id)
        .await?;
    let args = state.git.interactive_rebase_args(repo, action).await?;
    let id = state.next_id("console");
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(AppError::io)?;
    let address = listener.local_addr().map_err(AppError::io)?;
    let token = random_token()?;
    let current = std::env::current_exe().map_err(AppError::io)?;
    let mut command = Command::new(current);
    command
        .arg("--git-console-v2")
        .arg(address.to_string())
        .arg(&token)
        .current_dir(&repo.path);
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
    listener.set_nonblocking(true).map_err(AppError::io)?;
    let plan = ConsolePlan {
        token: token.clone(),
        id: id.clone(),
        repo_id: repo.id.clone(),
        kind: action.kind.clone(),
        executable: state.git.git_path(),
        shell_after: true,
        repository: repo.path.clone(),
        git_directory: repo.git_dir.clone(),
        args,
        isolated_home: state.git.isolated_home().map(PathBuf::from),
    };
    let initial = ExternalSession {
        id: id.clone(),
        repo_id: repo.id.clone(),
        kind: action.kind.clone(),
        status: "started".into(),
        exit_code: None,
        operation: None,
        message:
            "A separate interactive Git console is starting. Finish or abort the operation there."
                .into(),
    };
    let app = app.clone();
    let mut session = initial.clone();
    std::thread::spawn(move || {
        let mut lock = Some(lock);
        let connected = (|| -> Result<TcpStream> {
            let started = std::time::Instant::now();
            loop {
                match listener.accept() {
                    Ok((stream, address)) if address.ip().is_loopback() => return Ok(stream),
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(AppError::io(error)),
                }
                if child.try_wait().map_err(AppError::io)?.is_some() {
                    return Err(AppError::new(
                        "CONSOLE",
                        "Interactive console exited before connecting.",
                    ));
                }
                if started.elapsed() > Duration::from_secs(30) {
                    return Err(AppError::new(
                        "CONSOLE",
                        "Interactive console did not connect in time.",
                    ));
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        })();
        match connected {
            Ok(mut stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut hello = String::new();
                let authenticated = reader.read_line(&mut hello).is_ok() && hello.trim() == token;
                if !authenticated {
                    session.status = "failed".into();
                    session.message = "Interactive console authentication failed.".into();
                } else {
                    let sent = serde_json::to_writer(&mut stream, &plan)
                        .and_then(|_| stream.write_all(b"\n").map_err(serde_json::Error::io));
                    let _ = stream.flush();
                    let _ = stream.set_read_timeout(None);
                    if sent.is_ok() {
                        session.status = "running".into();
                        let _ = app.emit("external-session", &session);
                        loop {
                            let mut line = String::new();
                            match reader.read_line(&mut line) {
                                Ok(0) => break,
                                Ok(_) if line.len() <= 64 * 1024 => {}
                                _ => break,
                            }
                            let Ok(event) = serde_json::from_str::<ConsoleEvent>(&line) else {
                                break;
                            };
                            if event.token != token {
                                break;
                            }
                            session.status = event.status;
                            session.exit_code = event.code;
                            session.operation = event.operation;
                            session.message = redact(&event.message);
                            lock.take();
                            let _ = app.emit("external-session", &session);
                            let _ = app.emit("repository-changed", &session.repo_id);
                            if matches!(session.status.as_str(), "paused" | "completed" | "failed")
                            {
                                break;
                            }
                        }
                    } else {
                        session.status = "failed".into();
                        session.message = "Could not send the interactive console plan.".into();
                    }
                }
            }
            Err(error) => {
                session.status = "failed".into();
                session.message = error.to_string();
            }
        }
        lock.take();
        if matches!(session.status.as_str(), "started" | "running") {
            session.status = "failed".into();
            session.message =
                "Interactive console disconnected. Inspect Git operation state before continuing."
                    .into();
        }
        let _ = app.emit("external-session", &session);
        let _ = app.emit("repository-changed", &session.repo_id);
        let _ = child.wait();
    });
    Ok(initial)
}
fn random_token() -> Result<String> {
    #[cfg(windows)]
    {
        let mut bytes = [0u8; 32];
        unsafe {
            let status = windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                windows_sys::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            );
            if status != 0 {
                return Err(AppError::new(
                    "CONSOLE",
                    "Could not initialize console authentication.",
                ));
            }
        }
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    #[cfg(not(windows))]
    {
        use std::io::Read;
        let mut bytes = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut bytes))
            .map_err(AppError::io)?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}
pub fn console_entry() -> bool {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args
        .get(1)
        .is_none_or(|value| value != "--git-console-v2" && value != "--git-terminal-v2")
    {
        return false;
    }
    if args
        .get(1)
        .is_some_and(|value| value == "--git-terminal-v2")
    {
        return terminal_entry(&args);
    }
    if args.len() != 4 {
        std::process::exit(2);
    }
    let address = args[2].to_string_lossy();
    let Ok(address) = address.parse::<std::net::SocketAddr>() else {
        std::process::exit(2)
    };
    if !address.ip().is_loopback() {
        std::process::exit(2);
    }
    attach_console();
    let token = args[3].to_string_lossy();
    let result = (|| -> Result<i32> {
        let mut stream =
            TcpStream::connect_timeout(&address, Duration::from_secs(10)).map_err(AppError::io)?;
        writeln!(stream, "{token}").map_err(AppError::io)?;
        stream.flush().map_err(AppError::io)?;
        let mut line = String::new();
        BufReader::new(stream.try_clone().map_err(AppError::io)?)
            .read_line(&mut line)
            .map_err(AppError::io)?;
        if line.len() > 128 * 1024 {
            return Err(AppError::new("CONSOLE", "Invalid console plan."));
        }
        let plan: ConsolePlan = serde_json::from_str(&line).map_err(AppError::io)?;
        if plan.token != token || !plan.executable.is_absolute() {
            return Err(AppError::new("CONSOLE", "Invalid console authorization."));
        }
        println!(
            "QGitGraph · Interactive {}\nRepository: {}\n",
            plan.kind, plan.repository
        );
        let mut command = Command::new(&plan.executable);
        command.current_dir(&plan.repository).args(&plan.args);
        sanitize_environment(&mut command, true, true, plan.isolated_home.as_deref());
        command
            .env("GIT_PAGER", "cat")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let code = command.status().map_err(AppError::io)?.code().unwrap_or(1);
        let directory = std::path::Path::new(&plan.git_directory);
        let operation =
            if directory.join("rebase-merge").exists() || directory.join("rebase-apply").exists() {
                Some("rebase".to_owned())
            } else {
                None
            };
        let status = if operation.is_some() {
            "paused"
        } else if code == 0 {
            "completed"
        } else {
            "failed"
        };
        let message = if status == "paused" {
            "Rebase is paused. Resolve/edit and stage changes, then run git rebase --continue or --abort in this terminal."
        } else if code == 0 {
            "Git completed."
        } else {
            "Git failed. Inspect its output and repository state."
        };
        let event = ConsoleEvent {
            token: plan.token,
            status: status.into(),
            code: Some(code),
            operation,
            message: message.into(),
        };
        serde_json::to_writer(&mut stream, &event).map_err(AppError::io)?;
        stream.write_all(b"\n").map_err(AppError::io)?;
        stream.flush().map_err(AppError::io)?;
        drop(stream);
        if !plan.shell_after {
            return Ok(code);
        }
        println!("\n{message}\nThe following shell remains in this repository. Type exit when finished.\n");
        #[cfg(windows)]
        {
            let shell =
                PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut shell = Command::new(shell);
            shell
                .args(["-NoLogo", "-NoProfile"])
                .current_dir(&plan.repository);
            sanitize_environment(&mut shell, true, true, plan.isolated_home.as_deref());
            shell
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            let _ = shell.status();
        }
        Ok(code)
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
}
fn terminal_entry(args: &[std::ffi::OsString]) -> bool {
    if args.len() != 4 {
        std::process::exit(2);
    }
    let directory = PathBuf::from(&args[2]);
    if !directory.is_absolute() || !directory.is_dir() {
        std::process::exit(2);
    }
    attach_console();
    println!("QGitGraph · Repository terminal\n{}\n", directory.display());
    #[cfg(windows)]
    {
        let executable =
            PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(executable);
        command
            .args(["-NoLogo", "-NoProfile"])
            .current_dir(directory);
        let home = if args[3].is_empty() {
            None
        } else {
            Some(PathBuf::from(&args[3]))
        };
        sanitize_environment(&mut command, true, true, home.as_deref());
        command
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let code = command
            .status()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1);
        std::process::exit(code);
    }
    #[cfg(not(windows))]
    {
        std::process::exit(2);
    }
}
#[cfg(windows)]
fn attach_console() {
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*, System::Console::*};
        if GetConsoleWindow().is_null() {
            AllocConsole();
        }
        for (name, id, access) in [
            ("CONIN$", STD_INPUT_HANDLE, GENERIC_READ | GENERIC_WRITE),
            ("CONOUT$", STD_OUTPUT_HANDLE, GENERIC_READ | GENERIC_WRITE),
            ("CONOUT$", STD_ERROR_HANDLE, GENERIC_READ | GENERIC_WRITE),
        ] {
            let name: Vec<u16> = std::ffi::OsStr::new(name)
                .encode_wide()
                .chain(Some(0))
                .collect();
            let handle = CreateFileW(
                name.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            );
            SetStdHandle(id, handle);
        }
    }
}
#[cfg(not(windows))]
fn attach_console() {}
