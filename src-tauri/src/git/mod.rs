pub mod actions;
pub mod parse;
#[cfg(not(windows))]
mod process;
pub mod read;
#[cfg(windows)]
mod windows_process;

use crate::{
    error::{AppError, Result},
    model::Repository,
    performance::{self, Span},
};
#[cfg(not(windows))]
use process::ProcessTree;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};
#[cfg(not(windows))]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedMutexGuard, Semaphore};
use tokio_util::sync::CancellationToken;

const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_INPUT: usize = 8 * 1024 * 1024;
const CANCEL_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExecutableIdentity {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

impl ExecutableIdentity {
    fn read(path: PathBuf) -> Result<Self> {
        let metadata = std::fs::metadata(&path).map_err(|error| {
            AppError::new("GIT_UNAVAILABLE", format!("Could not inspect Git: {error}"))
        })?;
        if !path.is_absolute() || !metadata.is_file() {
            return Err(AppError::new(
                "GIT_UNAVAILABLE",
                "Git must be an existing absolute executable path.",
            ));
        }
        Ok(Self {
            path,
            modified: metadata.modified().map_err(AppError::io)?,
            size: metadata.len(),
        })
    }
}

struct CachedVersion {
    executable: ExecutableIdentity,
    version: String,
}

#[derive(Clone)]
pub struct GitService {
    executable: Arc<Mutex<PathBuf>>,
    tasks: Arc<Mutex<HashMap<String, CancellationToken>>>,
    cancelled: Arc<Mutex<VecDeque<(String, Instant)>>>,
    transactions: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    slots: Arc<Semaphore>,
    isolated_home: Option<PathBuf>,
    observers: Arc<Mutex<HashMap<String, HashSet<u32>>>>,
    version_cache: Arc<Mutex<Option<CachedVersion>>>,
}

#[derive(Debug)]
pub struct ProcessOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub struct RequestGuard {
    id: String,
    tasks: Arc<Mutex<HashMap<String, CancellationToken>>>,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&self.id);
        }
    }
}
struct ProcessGuard {
    id: String,
    pid: u32,
    processes: Arc<Mutex<HashMap<String, HashSet<u32>>>>,
}
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.processes.lock() {
            if let Some(pids) = processes.get_mut(&self.id) {
                pids.remove(&self.pid);
                if pids.is_empty() {
                    processes.remove(&self.id);
                }
            }
        }
    }
}

impl GitService {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            executable: Arc::new(Mutex::new(path.unwrap_or_else(find_git))),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(Mutex::new(VecDeque::new())),
            transactions: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(6)),
            isolated_home: None,
            observers: Arc::new(Mutex::new(HashMap::new())),
            version_cache: Arc::new(Mutex::new(None)),
        }
    }
    pub fn isolated(path: Option<PathBuf>, home: PathBuf) -> Self {
        let mut service = Self::new(path);
        service.isolated_home = Some(home);
        service
    }
    pub fn git_path(&self) -> PathBuf {
        self.executable.lock().unwrap().clone()
    }
    pub fn isolated_home(&self) -> Option<&Path> {
        self.isolated_home.as_deref()
    }
    pub fn active_process(&self, request_id: &str) -> Option<u32> {
        self.active_processes(request_id).into_iter().next()
    }
    pub fn active_processes(&self, request_id: &str) -> Vec<u32> {
        let mut pids: Vec<_> = self
            .observers
            .lock()
            .unwrap()
            .get(request_id)
            .into_iter()
            .flatten()
            .copied()
            .collect();
        pids.sort_unstable();
        pids
    }
    /// Successful supported versions are cached only while the selected file's
    /// path, modification time and size still match. Unsupported Git is returned
    /// uncached so diagnostics can display it; repository open still rejects it.
    pub async fn version(&self, repo: &Repository, request_id: &str) -> Result<String> {
        let _request = self.request_scope(request_id)?;
        self.check_request(request_id)?;
        let identity = ExecutableIdentity::read(self.git_path())?;
        {
            let mut cache = self.version_cache.lock().unwrap();
            if let Some(cached) = cache.as_ref() {
                if cached.executable == identity && supported_git(&cached.version) {
                    return Ok(cached.version.clone());
                }
            }
            *cache = None;
        }
        let output = self
            .run_output_at(
                repo,
                request_id,
                vec!["--version".into()],
                None,
                false,
                identity.path.clone(),
            )
            .await?;
        let version = String::from_utf8_lossy(&successful_bytes(output, false)?).into_owned();
        self.check_request(request_id)?;
        // Recheck after the process: an installer or a settings change can have
        // replaced Git while --version was running. Never cache that stale result.
        if supported_git(&version)
            && ExecutableIdentity::read(identity.path.clone())
                .ok()
                .as_ref()
                == Some(&identity)
        {
            let executable = self.executable.lock().unwrap();
            if *executable == identity.path {
                *self.version_cache.lock().unwrap() = Some(CachedVersion {
                    executable: identity,
                    version: version.clone(),
                });
            }
        }
        Ok(version)
    }
    pub fn set_git_path(&self, path: &str) -> Result<()> {
        let value = if path.trim().is_empty() {
            find_git()
        } else {
            let p = PathBuf::from(path);
            if !p.is_absolute() || !p.is_file() {
                return Err(AppError::new(
                    "GIT_PATH",
                    "Git must be an existing absolute executable path.",
                ));
            }
            #[cfg(windows)]
            if !p.extension().is_some_and(|v| v.eq_ignore_ascii_case("exe")) {
                return Err(AppError::new(
                    "GIT_PATH",
                    "Select the trusted git.exe executable, not a script.",
                ));
            }
            p
        };
        if !value.is_absolute() || !value.is_file() {
            return Err(AppError::new(
                "GIT_UNAVAILABLE",
                "Git was not found. Install Git for Windows or configure an absolute git.exe path.",
            ));
        }
        let mut executable = self.executable.lock().unwrap();
        if *executable != value {
            *executable = value;
            *self.version_cache.lock().unwrap() = None;
        }
        Ok(())
    }
    pub fn begin_request(&self, request_id: &str) -> Result<RequestGuard> {
        self.register_request(request_id, false)?
            .1
            .ok_or_else(|| AppError::new("REQUEST", "The request is already running."))
    }
    /// A public query may be invoked directly by Rust callers or inside an IPC
    /// request. Keep one owner around an entire joined query, borrowing an
    /// already registered token rather than letting its first child remove it.
    pub(crate) fn request_scope(&self, request_id: &str) -> Result<Option<RequestGuard>> {
        self.register_request(request_id, true)
            .map(|(_, guard)| guard)
    }
    fn register_request(
        &self,
        request_id: &str,
        allow_existing: bool,
    ) -> Result<(CancellationToken, Option<RequestGuard>)> {
        valid_request(request_id)?;
        let mut tasks = self.tasks.lock().unwrap();
        if let Some(token) = tasks.get(request_id) {
            return if allow_existing && !token.is_cancelled() {
                Ok((token.clone(), None))
            } else if allow_existing {
                Err(cancelled_error())
            } else {
                Err(AppError::new("REQUEST", "The request is already running."))
            };
        }
        if tasks.len() >= 128 {
            return Err(AppError::new("BUSY", "Too many pending requests."));
        }
        let mut cancelled = self.cancelled.lock().unwrap();
        trim_cancelled(&mut cancelled);
        if let Some(index) = cancelled.iter().position(|(id, _)| id == request_id) {
            cancelled.remove(index);
            return Err(cancelled_error());
        }
        let token = CancellationToken::new();
        tasks.insert(request_id.to_owned(), token.clone());
        Ok((
            token,
            Some(RequestGuard {
                id: request_id.to_owned(),
                tasks: self.tasks.clone(),
            }),
        ))
    }
    pub fn cancel(&self, request_id: &str) {
        if valid_request(request_id).is_err() {
            return;
        }
        let tasks = self.tasks.lock().unwrap();
        if let Some(token) = tasks.get(request_id) {
            token.cancel();
            return;
        }
        let mut pending = self.cancelled.lock().unwrap();
        trim_cancelled(&mut pending);
        pending.retain(|(id, _)| id != request_id);
        if pending.len() >= 256 {
            pending.pop_front();
        }
        pending.push_back((request_id.to_owned(), Instant::now()));
    }
    /// Also observes a cancel that arrived before registration, without consuming
    /// its tombstone. CPU-only loops can use check_request between batches.
    pub fn request_cancelled(&self, request_id: &str) -> bool {
        let tasks = self.tasks.lock().unwrap();
        if let Some(token) = tasks.get(request_id) {
            return token.is_cancelled();
        }
        let mut cancelled = self.cancelled.lock().unwrap();
        trim_cancelled(&mut cancelled);
        cancelled.iter().any(|(id, _)| id == request_id)
    }
    pub fn check_request(&self, request_id: &str) -> Result<()> {
        valid_request(request_id)?;
        if self.request_cancelled(request_id) {
            Err(cancelled_error())
        } else {
            Ok(())
        }
    }
    pub fn cancel_all(&self) {
        for token in self.tasks.lock().unwrap().values() {
            token.cancel();
        }
    }
    pub async fn transaction_for(
        &self,
        repo_id: &str,
        request_id: &str,
    ) -> Result<OwnedMutexGuard<()>> {
        let token = self
            .tasks
            .lock()
            .unwrap()
            .get(request_id)
            .cloned()
            .ok_or_else(|| AppError::new("REQUEST", "The request has not been registered."))?;
        let mutex = self.transaction_mutex(repo_id);
        tokio::select! { biased;
            _ = token.cancelled() => Err(cancelled_error()),
            guard = mutex.lock_owned() => if token.is_cancelled() { Err(cancelled_error()) } else { Ok(guard) },
        }
    }
    fn transaction_mutex(&self, repo_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.transactions
            .lock()
            .unwrap()
            .entry(repo_id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
    pub async fn transaction(&self, repo_id: &str) -> OwnedMutexGuard<()> {
        self.transaction_mutex(repo_id).lock_owned().await
    }
    pub async fn repository_transaction(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<OwnedMutexGuard<()>> {
        self.transaction_for(&repo.common_dir, request_id).await
    }
    pub async fn run(
        &self,
        repo: &Repository,
        request_id: &str,
        args: Vec<String>,
        write: bool,
    ) -> Result<String> {
        Ok(
            String::from_utf8_lossy(&self.run_bytes(repo, request_id, args, write).await?)
                .into_owned(),
        )
    }
    pub async fn run_bytes(
        &self,
        repo: &Repository,
        request_id: &str,
        args: Vec<String>,
        write: bool,
    ) -> Result<Vec<u8>> {
        let output = self.run_output(repo, request_id, args, None, write).await?;
        successful_bytes(output, write)
    }
    pub async fn run_with_input(
        &self,
        repo: &Repository,
        request_id: &str,
        args: Vec<String>,
        input: Vec<u8>,
        write: bool,
    ) -> Result<Vec<u8>> {
        if input.len() > MAX_INPUT {
            return Err(AppError::new(
                "INPUT_LIMIT",
                "Internal Git input exceeds 8 MiB.",
            ));
        }
        let output = self
            .run_output(repo, request_id, args, Some(input), write)
            .await?;
        successful_bytes(output, write)
    }
    pub async fn run_output(
        &self,
        repo: &Repository,
        request_id: &str,
        args: Vec<String>,
        input: Option<Vec<u8>>,
        write: bool,
    ) -> Result<ProcessOutput> {
        self.run_output_at(repo, request_id, args, input, write, self.git_path())
            .await
    }
    async fn run_output_at(
        &self,
        repo: &Repository,
        request_id: &str,
        args: Vec<String>,
        input: Option<Vec<u8>>,
        write: bool,
        executable: PathBuf,
    ) -> Result<ProcessOutput> {
        let verb = if performance::enabled() {
            performance::git_verb(&args)
        } else {
            "other"
        };
        let mut total_span = Span::begin(request_id, "git", verb);
        if write && !repo.trusted {
            return Err(AppError::new("UNTRUSTED", "Trust this repository before running Git write operations, hooks or remote helpers."));
        }
        if !executable.is_absolute() || !executable.is_file() {
            return Err(AppError::new("GIT_UNAVAILABLE", "Git is not available. Install Git for Windows or configure a trusted absolute git.exe path."));
        }
        if input.as_ref().is_some_and(|bytes| bytes.len() > MAX_INPUT) {
            return Err(AppError::new(
                "INPUT_LIMIT",
                "Internal Git input exceeds 8 MiB.",
            ));
        }
        let (token, _guard) = self.register_request(request_id, true)?;
        let mut queue_span = Span::begin(request_id, "queue", verb);
        let _permit = tokio::select! { biased;
            _ = token.cancelled() => { queue_span.outcome("cancelled"); total_span.outcome("cancelled"); return Err(cancelled_error()); },
            permit = self.slots.acquire() => permit.map_err(|_| AppError::new("CLOSED", "Application is closing."))?,
        };
        queue_span.complete();
        drop(queue_span);
        if token.is_cancelled() {
            total_span.outcome("cancelled");
            return Err(cancelled_error());
        }
        if args.iter().any(|a| a.contains('\0')) {
            return Err(AppError::new(
                "ARGUMENT",
                "A Git argument contains a NUL byte.",
            ));
        }
        let command = self.command(&executable, repo, &args, write);
        if token.is_cancelled() {
            total_span.outcome("cancelled");
            return Err(cancelled_error());
        }
        #[cfg(windows)]
        {
            let child = windows_process::NativeChild::spawn(
                command.as_std(),
                input.is_some(),
                request_id,
                verb,
            )?;
            let pid = child.pid;
            self.observers
                .lock()
                .unwrap()
                .entry(request_id.to_owned())
                .or_default()
                .insert(pid);
            let _process = ProcessGuard {
                id: request_id.to_owned(),
                pid,
                processes: self.observers.clone(),
            };
            let result = child
                .collect(
                    input,
                    token,
                    Duration::from_secs(if write { 900 } else { 120 }),
                    request_id,
                    verb,
                )
                .await;
            match &result {
                Ok(output) => {
                    total_span.output(
                        Some(output.stdout.len()),
                        Some(output.stderr.len()),
                        Some(output.code),
                    );
                    total_span.outcome(if output.code == 0 { "ok" } else { "exit" });
                }
                Err(error) => total_span.outcome(match error.code.as_str() {
                    "CANCELLED" => "cancelled",
                    "TIMEOUT" => "timeout",
                    "OUTPUT_LIMIT" => "output-limit",
                    _ => "error",
                }),
            }
            result
        }
        #[cfg(not(windows))]
        {
            let mut command = command;
            if input.is_some() {
                command.stdin(Stdio::piped());
            }
            let mut job_span = Span::begin(request_id, "job-create", verb);
            let tree = ProcessTree::new()?;
            job_span.complete();
            drop(job_span);
            if token.is_cancelled() {
                total_span.outcome("cancelled");
                return Err(cancelled_error());
            }
            let mut spawn_span = Span::begin(request_id, "spawn", verb);
            let mut child = command.spawn().map_err(|e| {
                AppError::new(
                    "GIT_UNAVAILABLE",
                    format!("Could not start Git at {}: {e}", executable.display()),
                )
            })?;
            spawn_span.complete();
            drop(spawn_span);
            let pid = match child.id() {
                Some(pid) => pid,
                None => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(AppError::new(
                        "PROCESS",
                        "Git exited before its process could be tracked.",
                    ));
                }
            };
            if let Err(error) = tree.attach_and_resume(pid, request_id, verb) {
                tree.terminate();
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
            let mut execution_span = Span::begin(request_id, "execution", verb);
            self.observers
                .lock()
                .unwrap()
                .entry(request_id.to_owned())
                .or_default()
                .insert(pid);
            let _process = ProcessGuard {
                id: request_id.to_owned(),
                pid,
                processes: self.observers.clone(),
            };
            let stdin = child.stdin.take();
            let writer = tokio::spawn(async move {
                if let (Some(mut stdin), Some(input)) = (stdin, input) {
                    stdin.write_all(&input).await.map_err(AppError::io)?;
                    stdin.shutdown().await.map_err(AppError::io)?;
                }
                Ok::<(), AppError>(())
            });
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("PROCESS", "Missing Git output pipe."))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| AppError::new("PROCESS", "Missing Git error pipe."))?;
            let out_tree = tree.clone();
            let err_tree = tree.clone();
            let out = tokio::spawn(async move { read_limited(stdout, out_tree).await });
            let err = tokio::spawn(async move { read_limited(stderr, err_tree).await });
            let timeout = Duration::from_secs(if write { 900 } else { 120 });
            let status = tokio::select! { biased;
                _ = token.cancelled() => { execution_span.outcome("cancelled"); total_span.outcome("cancelled"); tree.terminate(); let _ = child.kill().await; let _ = child.wait().await; Err(cancelled_error()) },
                status = child.wait() => status.map_err(AppError::io),
                _ = tokio::time::sleep(timeout) => { execution_span.outcome("timeout"); total_span.outcome("timeout"); tree.terminate(); let _ = child.kill().await; let _ = child.wait().await; Err(AppError::new("TIMEOUT", "Git timed out. Check authentication, signing tools and repository state before retrying.")) },
            };
            if let Ok(status) = &status {
                execution_span.output(None, None, status.code());
                execution_span.outcome(if status.success() { "ok" } else { "exit" });
            }
            drop(execution_span);
            let mut drain_span = Span::begin(request_id, "drain", verb);
            tree.terminate();
            let output = out.await.map_err(AppError::io)?;
            let errors = err.await.map_err(AppError::io)?;
            let written = writer.await.map_err(AppError::io)?;
            let stdout_bytes = output.as_ref().ok().map(Vec::len);
            let stderr_bytes = errors.as_ref().ok().map(Vec::len);
            let code = status.as_ref().ok().and_then(|status| status.code());
            drain_span.output(stdout_bytes, stderr_bytes, code);
            total_span.output(stdout_bytes, stderr_bytes, code);
            drain_span.complete();
            drop(drain_span);
            let status = status?;
            let stdout = output?;
            let stderr = errors?;
            if status.success() {
                written?;
            }
            total_span.outcome(if status.success() { "ok" } else { "exit" });
            Ok(ProcessOutput {
                code: status.code().unwrap_or(-1),
                stdout,
                stderr,
            })
        }
    }
    fn command(
        &self,
        executable: &Path,
        repo: &Repository,
        args: &[String],
        write: bool,
    ) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(executable);
        command
            .current_dir(&repo.path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        sanitize_environment(
            command.as_std_mut(),
            write && repo.trusted,
            false,
            self.isolated_home.as_deref(),
        );
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "false")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_OPTIONAL_LOCKS", if write { "1" } else { "0" });
        if !write {
            command.env("GIT_LITERAL_PATHSPECS", "1");
        }
        command.args([
            "--no-pager",
            "-c",
            "color.ui=false",
            "-c",
            "core.quotepath=false",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-c",
            "log.showSignature=false",
        ]);
        command.args(args);
        #[cfg(windows)]
        command.creation_flags(0x08000000 | 0x00000004);
        command
    }
}

pub(crate) fn supported_git(version: &str) -> bool {
    let Some(version) = version.strip_prefix("git version ") else {
        return false;
    };
    let mut parts = version.split('.');
    let major = parts.next().and_then(|part| part.parse::<u32>().ok());
    let minor = parts.next().and_then(|part| part.parse::<u32>().ok());
    matches!((major, minor), (Some(major), Some(minor)) if major > 2 || major == 2 && minor >= 38)
}

pub fn sanitize_environment(
    command: &mut std::process::Command,
    trusted: bool,
    interactive: bool,
    isolated_home: Option<&Path>,
) {
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if name.starts_with("GIT_") {
            command.env_remove(&key);
            let auth = matches!(
                name.as_str(),
                "GIT_ASKPASS" | "GIT_SSH" | "GIT_SSH_COMMAND" | "GIT_SSH_VARIANT"
            );
            let editor = matches!(name.as_str(), "GIT_EDITOR" | "GIT_SEQUENCE_EDITOR");
            if trusted && isolated_home.is_none() && (auth || interactive && editor) {
                command.env(name, value);
            }
        }
    }
    if let Some(home) = isolated_home {
        command
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", home.join(".gitconfig"))
            .env("GCM_INTERACTIVE", "Never");
    }
}

pub fn redact(text: &str) -> String {
    let mut output = text.to_owned();
    for prefix in ["https://", "http://", "ssh://"] {
        let mut offset = 0;
        while let Some(found) = output[offset..].find(prefix) {
            let start = offset + found + prefix.len();
            let end = output[start..]
                .find(['/', '\n', '\r', ' ', '\t'])
                .map(|v| start + v)
                .unwrap_or(output.len());
            if let Some(at) = output[start..end].find('@') {
                output.replace_range(start..start + at, "[redacted]");
                offset = start + "[redacted]@".len();
            } else {
                offset = end;
            }
            if offset >= output.len() {
                break;
            }
        }
    }
    output
}
fn successful_bytes(output: ProcessOutput, write: bool) -> Result<Vec<u8>> {
    if output.code != 0 {
        let detail = String::from_utf8_lossy(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        });
        return Err(AppError::git(if detail.trim().is_empty() {
            format!("Git exited with code {}.", output.code)
        } else {
            redact(&detail)
        }));
    }
    if write && !output.stderr.is_empty() {
        let mut bytes = output.stdout;
        if !bytes.is_empty() {
            bytes.push(b'\n');
        }
        bytes.extend(output.stderr);
        Ok(redact(&String::from_utf8_lossy(&bytes)).into_bytes())
    } else {
        Ok(output.stdout)
    }
}
#[cfg(not(windows))]
async fn read_limited<R: AsyncRead + Unpin>(mut reader: R, tree: ProcessTree) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 32768];
    loop {
        let read = reader.read(&mut chunk).await.map_err(AppError::io)?;
        if read == 0 {
            break;
        }
        if buffer.len() + read > MAX_OUTPUT {
            tree.terminate();
            return Err(AppError::new(
                "OUTPUT_LIMIT",
                "Git output exceeds 32 MiB. Narrow the query or select a smaller file.",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(buffer)
}
fn valid_request(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        Err(AppError::new("REQUEST", "Invalid request identifier."))
    } else {
        Ok(())
    }
}
fn trim_cancelled(values: &mut VecDeque<(String, Instant)>) {
    while values
        .front()
        .is_some_and(|(_, at)| at.elapsed() > CANCEL_TTL)
    {
        values.pop_front();
    }
}
fn cancelled_error() -> AppError {
    AppError::new("CANCELLED", "Operation cancelled. Writes are not rolled back; refresh and inspect the repository before continuing.")
}

pub fn find_git() -> PathBuf {
    #[cfg(windows)]
    for base in [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
    ]
    .into_iter()
    .flatten()
    {
        for relative in [
            "Git/cmd/git.exe",
            "Git/bin/git.exe",
            "Git/mingw64/bin/git.exe",
        ] {
            let path = Path::new(&base).join(relative);
            if path.is_absolute() && path.is_file() {
                return path;
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            if !directory.is_absolute() {
                continue;
            }
            let path = directory.join(if cfg!(windows) { "git.exe" } else { "git" });
            if path.is_file() {
                return path;
            }
        }
    }
    std::env::temp_dir()
        .join("qgitgraph-missing-git")
        .join(if cfg!(windows) { "git.exe" } else { "git" })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_can_arrive_before_registration_and_is_bounded() {
        let service = GitService::new(None);
        service.cancel("before");
        assert_eq!(
            service.begin_request("before").err().unwrap().code,
            "CANCELLED"
        );
        assert!(service.begin_request("before").is_ok());
        for n in 0..1000 {
            service.cancel(&format!("pending-{n}"));
        }
        assert!(service.cancelled.lock().unwrap().len() <= 256);
    }
    #[test]
    fn process_guards_remove_only_their_own_pid_and_keep_order_deterministic() {
        let service = GitService::new(None);
        service
            .observers
            .lock()
            .unwrap()
            .insert("parallel".into(), HashSet::from([41, 12]));
        let first = ProcessGuard {
            id: "parallel".into(),
            pid: 12,
            processes: service.observers.clone(),
        };
        let second = ProcessGuard {
            id: "parallel".into(),
            pid: 41,
            processes: service.observers.clone(),
        };
        assert_eq!(service.active_processes("parallel"), vec![12, 41]);
        assert_eq!(service.active_process("parallel"), Some(12));
        drop(first);
        assert_eq!(service.active_processes("parallel"), vec![41]);
        drop(second);
        assert!(service.active_processes("parallel").is_empty());
        assert!(!service.observers.lock().unwrap().contains_key("parallel"));
    }
    #[test]
    fn nested_request_scopes_borrow_tokens_and_preserve_pending_cancellation() {
        let service = GitService::new(None);
        let owner = service.request_scope("nested").unwrap().unwrap();
        assert!(service.request_scope("nested").unwrap().is_none());
        assert_eq!(
            service.begin_request("nested").err().unwrap().code,
            "REQUEST"
        );
        service.cancel("nested");
        assert!(service.request_cancelled("nested"));
        assert_eq!(
            service.request_scope("nested").err().unwrap().code,
            "CANCELLED"
        );
        drop(owner);
        assert!(!service.request_cancelled("nested"));
        service.cancel("before-scope");
        assert!(service.request_cancelled("before-scope"));
        assert_eq!(
            service.check_request("before-scope").unwrap_err().code,
            "CANCELLED"
        );
        assert_eq!(
            service.request_scope("before-scope").err().unwrap().code,
            "CANCELLED"
        );
        assert!(!service.request_cancelled("before-scope"));
        assert!(service.request_scope("before-scope").unwrap().is_some());
        service.cancelled.lock().unwrap().push_back((
            "expired".into(),
            Instant::now() - CANCEL_TTL - Duration::from_secs(1),
        ));
        assert!(!service.request_cancelled("expired"));
    }
    #[tokio::test]
    async fn version_cache_checks_executable_metadata_and_preserves_unchanged_settings() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory
            .path()
            .join(if cfg!(windows) { "git.exe" } else { "git" });
        let other = directory
            .path()
            .join(if cfg!(windows) { "other.exe" } else { "other" });
        std::fs::write(&executable, b"not executable").unwrap();
        std::fs::write(&other, b"not executable").unwrap();
        let service = GitService::new(Some(executable.clone()));
        let repo = Repository {
            id: String::new(),
            path: directory.path().to_string_lossy().into_owned(),
            name: String::new(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        };
        *service.version_cache.lock().unwrap() = Some(CachedVersion {
            executable: ExecutableIdentity::read(executable.clone()).unwrap(),
            version: "git version 2.47.0.windows.2\n".into(),
        });
        service.set_git_path(executable.to_str().unwrap()).unwrap();
        assert!(service.version_cache.lock().unwrap().is_some());
        assert!(service
            .version(&repo, "warm-version")
            .await
            .unwrap()
            .starts_with("git version "));
        let request = service.begin_request("cancel-warm-version").unwrap();
        service.cancel("cancel-warm-version");
        assert_eq!(
            service
                .version(&repo, "cancel-warm-version")
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        drop(request);
        // Same path, changed size: a cached answer must not mask launch failure.
        std::fs::write(&executable, b"changed invalid executable size").unwrap();
        assert!(service.version(&repo, "changed-version").await.is_err());
        assert!(service.version_cache.lock().unwrap().is_none());
        *service.version_cache.lock().unwrap() = Some(CachedVersion {
            executable: ExecutableIdentity::read(executable.clone()).unwrap(),
            version: "git version 2.38.0\n".into(),
        });
        service.set_git_path(other.to_str().unwrap()).unwrap();
        assert!(service.version_cache.lock().unwrap().is_none());
    }
    #[test]
    fn redacts_url_credentials_without_corrupting_non_ascii_text() {
        assert_eq!(
            redact("失败 https://user:secret@example.com/repo"),
            "失败 https://[redacted]@example.com/repo"
        );
        assert_eq!(
            redact("ssh://person@host/repo"),
            "ssh://[redacted]@host/repo"
        );
    }
}
