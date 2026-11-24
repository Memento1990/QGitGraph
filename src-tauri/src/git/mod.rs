pub mod actions;
pub mod parse;
#[cfg(not(windows))]
mod process;
pub mod read;
#[cfg(windows)]
mod windows_process;
mod working_actions;

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
struct NativeRepository {
    repo: Repository,
    epoch: u64,
    identity: Option<crate::authority::RepositoryIdentity>,
}

#[derive(Clone)]
struct RequestBinding {
    repository: NativeRepository,
    token: CancellationToken,
    requires_trust: bool,
}

#[derive(Default)]
struct NativeAuthorization {
    required: bool,
    sequence: u64,
    repositories: HashMap<String, NativeRepository>,
    bindings: HashMap<String, RequestBinding>,
    trust_policy: Option<Arc<crate::trust::TrustService>>,
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
    authorization: Arc<Mutex<NativeAuthorization>>,
    parent_authorization: Option<Arc<(GitService, String)>>,
    clean_previews: Arc<Mutex<actions::clean::CleanStore>>,
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
    authorization: Arc<Mutex<NativeAuthorization>>,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        // 注册与释放的锁顺序一致；旧 owner 不能留下可借用的授权绑定。
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(&self.id);
            self.authorization.lock().unwrap().bindings.remove(&self.id);
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
            authorization: Arc::new(Mutex::new(NativeAuthorization::default())),
            parent_authorization: None,
            clean_previews: Arc::new(Mutex::new(actions::clean::CleanStore::default())),
        }
    }
    pub fn isolated(path: Option<PathBuf>, home: PathBuf) -> Self {
        let mut service = Self::new(path);
        service.isolated_home = Some(home);
        service
    }

    pub(super) fn nested_probe_service(&self, request_id: &str) -> Result<GitService> {
        self.check_request(request_id)?;
        let mut service = self.clone();
        service.authorization = Arc::new(Mutex::new(NativeAuthorization::default()));
        service.parent_authorization = Some(Arc::new((self.clone(), request_id.to_owned())));
        Ok(service)
    }

    pub(super) fn nested_read_service(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<GitService> {
        let service = self.nested_probe_service(request_id)?;
        service.require_native_authorization();
        let identity = crate::authority::RepositoryIdentity::capture(repo)?.0;
        service.publish_native_repository(repo, Some(identity));
        service.bind_repository_request(repo, request_id, false)?;
        Ok(service)
    }

    pub(crate) fn require_native_authorization(&self) {
        self.authorization.lock().unwrap().required = true;
    }

    pub(crate) fn set_trust_policy(&self, policy: Arc<crate::trust::TrustService>) {
        self.authorization.lock().unwrap().trust_policy = Some(policy);
    }

    pub(crate) fn publish_native_repository(
        &self,
        repo: &Repository,
        identity: Option<crate::authority::RepositoryIdentity>,
    ) -> u64 {
        let mut authorization = self.authorization.lock().unwrap();
        authorization.required = true;
        if let Some(previous) = authorization.repositories.get(&repo.id) {
            if same_repository(&previous.repo, repo)
                && previous.repo.trusted == repo.trusted
                && previous.identity == identity
            {
                return previous.epoch;
            }
        }
        self.invalidate_clean_repository(&repo.id);
        authorization.sequence += 1;
        let epoch = authorization.sequence;
        // 只取消该仓库旧 epoch 的请求，不取消共享 common-dir 的其他 worktree。
        for binding in authorization.bindings.values() {
            if binding.repository.repo.id == repo.id {
                binding.token.cancel();
            }
        }
        authorization.repositories.insert(
            repo.id.clone(),
            NativeRepository {
                repo: repo.clone(),
                epoch,
                identity,
            },
        );
        epoch
    }

    pub(crate) fn validate_native_repository_identity(&self, repo: &Repository) -> Result<()> {
        let current = self
            .authorization
            .lock()
            .unwrap()
            .repositories
            .get(&repo.id)
            .cloned()
            .ok_or_else(authorization_error)?;
        if !same_repository(&current.repo, repo) {
            return Err(authorization_error());
        }
        current
            .identity
            .ok_or_else(authorization_error)?
            .validate(repo)?;
        Ok(())
    }

    pub(crate) fn native_repositories(&self) -> Vec<Repository> {
        self.authorization
            .lock()
            .unwrap()
            .repositories
            .values()
            .map(|entry| entry.repo.clone())
            .collect()
    }

    pub(crate) fn native_epoch(&self, repo_id: &str) -> u64 {
        self.authorization
            .lock()
            .unwrap()
            .repositories
            .get(repo_id)
            .map_or(0, |repo| repo.epoch)
    }

    pub(crate) fn bind_repository_request(
        &self,
        repo: &Repository,
        request_id: &str,
        requires_trust: bool,
    ) -> Result<()> {
        self.check_request(request_id)?;
        let tasks = self.tasks.lock().unwrap();
        let token = tasks
            .get(request_id)
            .ok_or_else(|| AppError::new("REQUEST", "The request has not been registered."))?;
        if token.is_cancelled() {
            return Err(cancelled_error());
        }
        let mut authorization = self.authorization.lock().unwrap();
        if let Some(binding) = authorization.bindings.get_mut(request_id) {
            if !same_repository(&binding.repository.repo, repo)
                || binding.repository.repo.trusted != repo.trusted
            {
                return Err(authorization_error());
            }
            binding.requires_trust |= requires_trust;
            return validate_binding(&authorization, request_id);
        }
        let Some(current) = authorization.repositories.get(&repo.id).cloned() else {
            // 独立 Rust GitService 测试仍可显式传可信 fixture；正式 AppState
            // 从创建起强制原生发布，renderer JSON 无法构造 authority。
            if authorization.required && (requires_trust || repo.trusted || !repo.id.is_empty()) {
                return Err(authorization_error());
            }
            if requires_trust && !repo.trusted {
                return Err(untrusted_error());
            }
            return Ok(());
        };
        if !same_repository(&current.repo, repo) || current.repo.trusted != repo.trusted {
            return Err(authorization_error());
        }
        if authorization.required && current.identity.is_none() {
            return Err(authorization_error());
        }
        if requires_trust && !current.repo.trusted {
            return Err(untrusted_error());
        }
        authorization.bindings.insert(
            request_id.to_owned(),
            RequestBinding {
                repository: current,
                token: token.clone(),
                requires_trust,
            },
        );
        Ok(())
    }

    pub(crate) fn check_repository_authorization(
        &self,
        repo: &Repository,
        request_id: &str,
        requires_trust: bool,
    ) -> Result<()> {
        self.bind_repository_request(repo, request_id, requires_trust)?;
        self.check_request(request_id)
    }

    pub(crate) fn with_repository_authorization<T>(
        &self,
        repo: &Repository,
        request_id: &str,
        requires_trust: bool,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.check_repository_authorization(repo, request_id, requires_trust)?;
        if let Some(parent) = &self.parent_authorization {
            return parent.0.with_parent_authorization(&parent.1, || {
                self.with_local_repository_authorization(repo, request_id, operation)
            });
        }
        self.with_local_repository_authorization(repo, request_id, operation)
    }

    fn with_parent_authorization<T>(
        &self,
        request_id: &str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.check_request(request_id)?;
        let authorization = self.authorization.lock().unwrap();
        validate_binding(&authorization, request_id)?;
        operation()
    }

    fn with_local_repository_authorization<T>(
        &self,
        repo: &Repository,
        request_id: &str,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let binding = self
            .authorization
            .lock()
            .unwrap()
            .bindings
            .get(request_id)
            .cloned();
        // 句柄保持到 spawn 完成（进程路径另持有到收集结束），epoch 锁封住
        // 最后一次复核与启动之间的撤销窗口，已启动外部 console 不强杀。
        let _pins = binding
            .as_ref()
            .and_then(|binding| binding.repository.identity.as_ref())
            .map(|identity| identity.validate(repo))
            .transpose()?;
        let authorization = self.authorization.lock().unwrap();
        validate_binding(&authorization, request_id)?;
        operation()
    }

    fn repository_pins(
        &self,
        repo: &Repository,
        request_id: &str,
    ) -> Result<Option<crate::authority::RepositoryPins>> {
        let binding = self
            .authorization
            .lock()
            .unwrap()
            .bindings
            .get(request_id)
            .cloned();
        binding
            .and_then(|binding| binding.repository.identity)
            .map(|identity| identity.validate(repo))
            .transpose()
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
                authorization: self.authorization.clone(),
            }),
        ))
    }
    pub fn cancel(&self, request_id: &str) {
        if valid_request(request_id).is_err() {
            return;
        }
        self.invalidate_clean_request(request_id);
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
        if let Some(parent) = &self.parent_authorization {
            parent.0.check_request(&parent.1)?;
        }
        if self.request_cancelled(request_id) {
            return Err(cancelled_error());
        }
        let binding = {
            let authorization = self.authorization.lock().unwrap();
            validate_binding(&authorization, request_id)?;
            authorization.bindings.get(request_id).cloned()
        };
        if let Some(binding) = binding {
            if let Some(identity) = &binding.repository.identity {
                identity.validate(&binding.repository.repo)?;
            }
        }
        Ok(())
    }
    pub fn cancel_all(&self) {
        self.invalidate_all_clean_previews();
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
        let guard = tokio::select! { biased;
            _ = token.cancelled() => return Err(cancelled_error()),
            guard = mutex.lock_owned() => guard,
        };
        self.check_request(request_id)?;
        Ok(guard)
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
        self.bind_repository_request(repo, request_id, false)?;
        let guard = self.transaction_for(&repo.common_dir, request_id).await?;
        self.check_repository_authorization(repo, request_id, false)?;
        Ok(guard)
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
        self.bind_repository_request(repo, request_id, write)?;
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
        self.check_repository_authorization(repo, request_id, write)?;
        let _repository_pins = self.repository_pins(repo, request_id)?;
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
            let child = self.with_repository_authorization(repo, request_id, write, || {
                windows_process::NativeChild::spawn(
                    command.as_std(),
                    input.is_some(),
                    request_id,
                    verb,
                )
            })?;
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
            let mut child = self.with_repository_authorization(repo, request_id, write, || {
                command.spawn().map_err(|e| {
                    AppError::new(
                        "GIT_UNAVAILABLE",
                        format!("Could not start Git at {}: {e}", executable.display()),
                    )
                })
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

fn same_repository(left: &Repository, right: &Repository) -> bool {
    left.id == right.id
        && left.path == right.path
        && left.git_dir == right.git_dir
        && left.common_dir == right.common_dir
        && left.bare == right.bare
}

fn authorization_error() -> AppError {
    AppError::new("AUTHORIZATION_CHANGED", "Native repository authorization changed or the request belongs to a different repository. Reopen and review trust before retrying. Writes are not rolled back.")
}

fn untrusted_error() -> AppError {
    AppError::new(
        "UNTRUSTED",
        "Trust this repository before running Git write operations, hooks or remote helpers.",
    )
}

fn validate_binding(authorization: &NativeAuthorization, request_id: &str) -> Result<()> {
    let Some(binding) = authorization.bindings.get(request_id) else {
        return Ok(());
    };
    if binding.token.is_cancelled() {
        return Err(cancelled_error());
    }
    let current = authorization
        .repositories
        .get(&binding.repository.repo.id)
        .ok_or_else(authorization_error)?;
    if current.epoch != binding.repository.epoch
        || !same_repository(&current.repo, &binding.repository.repo)
        || current.repo.trusted != binding.repository.repo.trusted
    {
        return Err(authorization_error());
    }
    if binding.requires_trust && !current.repo.trusted {
        return Err(untrusted_error());
    }
    if current.repo.trusted
        && authorization
            .trust_policy
            .as_ref()
            .is_some_and(|policy| !policy.decision(&current.repo).0)
    {
        binding.token.cancel();
        return Err(authorization_error());
    }
    Ok(())
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
    async fn native_fixture() -> (tempfile::TempDir, GitService, Repository) {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let root = directory.path().join("repository 中文 with spaces");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(home.join(".gitconfig"), b"").unwrap();
        let service = GitService::isolated(None, home);
        let path = crate::state::display_path(&std::fs::canonicalize(&root).unwrap());
        let repo = Repository {
            id: path.clone(),
            path: path.clone(),
            name: "Native authorization fixture".into(),
            git_dir: Path::new(&path).join(".git").to_string_lossy().into_owned(),
            common_dir: Path::new(&path).join(".git").to_string_lossy().into_owned(),
            head: None,
            branch: Some("main".into()),
            trusted: true,
            bare: false,
        };
        for args in [
            vec!["init", "--quiet", "--initial-branch=main", "--template="],
            vec![
                "-c",
                "user.name=Native Fixture",
                "-c",
                "user.email=native@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "--message=fixture",
            ],
        ] {
            service
                .run(
                    &repo,
                    "prepare-native-fixture",
                    crate::state::args(&args),
                    true,
                )
                .await
                .unwrap();
        }
        (directory, service, repo)
    }

    fn publish(service: &GitService, repo: &Repository) -> u64 {
        service.publish_native_repository(
            repo,
            Some(
                crate::authority::RepositoryIdentity::capture(repo)
                    .unwrap()
                    .0,
            ),
        )
    }

    #[tokio::test]
    async fn native_binding_rejects_json_authority_and_repo_or_common_directory_substitution() {
        let (_fixture, service, repo) = native_fixture().await;
        service.require_native_authorization();
        let json = serde_json::json!({"id":repo.id,"path":repo.path,"name":"forged", "gitDir":repo.git_dir,"commonDir":repo.common_dir,"head":null,"branch":null,"trusted":true,"bare":false,"epoch":999999});
        let forged: Repository = serde_json::from_value(json).unwrap();
        assert_eq!(
            service
                .run(
                    &forged,
                    "json-authority",
                    crate::state::args(&["update-ref", "refs/heads/forged", "HEAD"]),
                    true
                )
                .await
                .unwrap_err()
                .code,
            "AUTHORIZATION_CHANGED"
        );
        publish(&service, &repo);
        let _owner = service.begin_request("repo-bound").unwrap();
        service
            .bind_repository_request(&repo, "repo-bound", true)
            .unwrap();
        let mut wrong_common = repo.clone();
        wrong_common.common_dir = repo.path.clone();
        let mut wrong_repo = repo.clone();
        wrong_repo.id.push_str("-other");
        let mut wrong_git = repo.clone();
        wrong_git.git_dir = repo.path.clone();
        for replacement in [wrong_common, wrong_repo, wrong_git] {
            assert_eq!(
                service
                    .run(
                        &replacement,
                        "repo-bound",
                        crate::state::args(&["update-ref", "refs/heads/forged", "HEAD"]),
                        true
                    )
                    .await
                    .unwrap_err()
                    .code,
                "AUTHORIZATION_CHANGED"
            );
            assert!(service.active_processes("repo-bound").is_empty());
        }
        assert!(!Path::new(&repo.git_dir).join("refs/heads/forged").exists());
    }

    #[tokio::test]
    async fn native_revoke_stops_transaction_queue_and_regrant_never_revives_old_request() {
        let (_fixture, service, repo) = native_fixture().await;
        let epoch = publish(&service, &repo);
        let _owner = service.begin_request("queued-native-transaction").unwrap();
        service
            .bind_repository_request(&repo, "queued-native-transaction", true)
            .unwrap();
        let blocker = service.transaction(&repo.common_dir).await;
        let queued = service.repository_transaction(&repo, "queued-native-transaction");
        tokio::pin!(queued);
        tokio::select! {
            _ = &mut queued => panic!("transaction must still be queued"),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {},
        }
        let mut revoked = repo.clone();
        revoked.trusted = false;
        assert!(publish(&service, &revoked) > epoch);
        assert!(publish(&service, &repo) > epoch);
        drop(blocker);
        assert_eq!(queued.await.err().unwrap().code, "CANCELLED");
        assert!(service
            .active_processes("queued-native-transaction")
            .is_empty());
        assert_eq!(
            service
                .run(
                    &repo,
                    "queued-native-transaction",
                    crate::state::args(&["update-ref", "refs/heads/late", "HEAD"]),
                    true
                )
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert!(!Path::new(&repo.git_dir).join("refs/heads/late").exists());
        service
            .run(
                &repo,
                "new-native-epoch",
                crate::state::args(&["update-ref", "refs/heads/new-epoch", "HEAD"]),
                true,
            )
            .await
            .unwrap();
        assert!(Path::new(&repo.git_dir)
            .join("refs/heads/new-epoch")
            .exists());
    }

    #[tokio::test]
    async fn native_revoke_stops_process_slot_queue_and_later_steps_without_rollback() {
        let (_fixture, service, repo) = native_fixture().await;
        publish(&service, &repo);
        let _owner = service.begin_request("native-multi-step").unwrap();
        service
            .bind_repository_request(&repo, "native-multi-step", true)
            .unwrap();
        service
            .run(
                &repo,
                "native-multi-step",
                crate::state::args(&["update-ref", "refs/heads/first-step", "HEAD"]),
                true,
            )
            .await
            .unwrap();
        let slots = service.slots.clone().acquire_many_owned(6).await.unwrap();
        let queued = service.run(
            &repo,
            "native-multi-step",
            crate::state::args(&["update-ref", "refs/heads/second-step", "HEAD"]),
            true,
        );
        tokio::pin!(queued);
        tokio::select! {
            _ = &mut queued => panic!("child must wait for a process slot"),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {},
        }
        let mut revoked = repo.clone();
        revoked.trusted = false;
        publish(&service, &revoked);
        publish(&service, &repo);
        drop(slots);
        assert_eq!(queued.await.unwrap_err().code, "CANCELLED");
        assert!(Path::new(&repo.git_dir)
            .join("refs/heads/first-step")
            .exists());
        assert!(!Path::new(&repo.git_dir)
            .join("refs/heads/second-step")
            .exists());
        assert!(service.active_processes("native-multi-step").is_empty());
    }

    #[tokio::test]
    async fn native_revoke_cancels_only_bound_repo_not_sibling_worktree_with_same_common_dir() {
        let (fixture, service, repo) = native_fixture().await;
        let linked_path = fixture.path().join("linked worktree");
        service
            .run(
                &repo,
                "prepare-native-linked",
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--quiet".into(),
                    "-b".into(),
                    "linked".into(),
                    linked_path.to_string_lossy().into_owned(),
                ],
                true,
            )
            .await
            .unwrap();
        let mut linked = repo.clone();
        linked.path = crate::state::display_path(&std::fs::canonicalize(&linked_path).unwrap());
        linked.id = linked.path.clone();
        let output = service
            .run(
                &linked,
                "discover-native-linked",
                crate::state::args(&[
                    "rev-parse",
                    "--path-format=absolute",
                    "--absolute-git-dir",
                    "--git-common-dir",
                ]),
                false,
            )
            .await
            .unwrap();
        let directories: Vec<_> = output.lines().collect();
        linked.git_dir = directories[0].into();
        linked.common_dir = directories[1].into();
        assert_eq!(
            std::fs::canonicalize(&linked.common_dir).unwrap(),
            std::fs::canonicalize(&repo.common_dir).unwrap()
        );
        publish(&service, &repo);
        publish(&service, &linked);
        let _first = service.begin_request("revoke-first-worktree").unwrap();
        let _second = service.begin_request("preserve-linked-worktree").unwrap();
        service
            .bind_repository_request(&repo, "revoke-first-worktree", true)
            .unwrap();
        service
            .bind_repository_request(&linked, "preserve-linked-worktree", true)
            .unwrap();
        let mut revoked = repo.clone();
        revoked.trusted = false;
        publish(&service, &revoked);
        assert!(service.request_cancelled("revoke-first-worktree"));
        assert!(!service.request_cancelled("preserve-linked-worktree"));
        service.check_request("preserve-linked-worktree").unwrap();
        service
            .run(
                &linked,
                "preserve-linked-worktree",
                crate::state::args(&["update-ref", "refs/heads/linked-still-authorized", "HEAD"]),
                true,
            )
            .await
            .unwrap();
        assert!(Path::new(&repo.git_dir)
            .join("refs/heads/linked-still-authorized")
            .exists());
    }

    #[tokio::test]
    async fn native_identity_recheck_rejects_replaced_administration_before_next_child() {
        let (_fixture, service, repo) = native_fixture().await;
        publish(&service, &repo);
        let _owner = service.begin_request("native-identity-recheck").unwrap();
        service
            .bind_repository_request(&repo, "native-identity-recheck", true)
            .unwrap();
        let original = Path::new(&repo.path).join("original-git");
        std::fs::rename(&repo.git_dir, &original).unwrap();
        std::fs::create_dir(&repo.git_dir).unwrap();
        assert_eq!(
            service
                .run(
                    &repo,
                    "native-identity-recheck",
                    crate::state::args(&["update-ref", "refs/heads/replaced", "HEAD"]),
                    true
                )
                .await
                .unwrap_err()
                .code,
            "AUTHORIZATION_CHANGED"
        );
        assert!(service
            .active_processes("native-identity-recheck")
            .is_empty());
        std::fs::remove_dir(&repo.git_dir).unwrap();
        std::fs::rename(original, &repo.git_dir).unwrap();
    }

    async fn wait_for_native_marker(path: &Path) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Git fixture must enter the gated phase");
    }

    fn native_hook(repo: &Repository, name: &str, script: &str) {
        let path = Path::new(&repo.git_dir).join("hooks").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[tokio::test]
    async fn native_revoke_terminates_only_its_running_managed_child_and_preserves_other_requests()
    {
        let (_fixture, service, repo) = native_fixture().await;
        let ready = Path::new(&repo.path).join("managed-ready");
        native_hook(&repo, "pre-commit", "#!/bin/sh\nprintf ready > managed-ready\nwhile ! test -f managed-release; do sleep 0.02; done\n");
        publish(&service, &repo);
        let _owner = service.begin_request("native-running-child").unwrap();
        service
            .bind_repository_request(&repo, "native-running-child", true)
            .unwrap();
        let independent = service.begin_request("native-unrelated-request").unwrap();
        let running_service = service.clone();
        let running_repo = repo.clone();
        let running = tokio::spawn(async move {
            running_service
                .run(
                    &running_repo,
                    "native-running-child",
                    crate::state::args(&[
                        "-c",
                        "user.name=Native Fixture",
                        "-c",
                        "user.email=native@example.invalid",
                        "-c",
                        "commit.gpgsign=false",
                        "commit",
                        "--quiet",
                        "--allow-empty",
                        "--message=must stop",
                    ]),
                    true,
                )
                .await
        });
        wait_for_native_marker(&ready).await;
        assert!(!service.active_processes("native-running-child").is_empty());
        let mut revoked = repo.clone();
        revoked.trusted = false;
        publish(&service, &revoked);
        let error = tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert!(service.active_processes("native-running-child").is_empty());
        assert!(!service.request_cancelled("native-unrelated-request"));
        std::fs::write(Path::new(&repo.path).join("managed-release"), b"release").unwrap();
        drop(independent);
    }

    #[tokio::test]
    async fn native_sync_revoke_after_pull_hook_never_starts_push_and_keeps_integrated_head() {
        let (fixture, service, repo) = native_fixture().await;
        let remote_path = fixture.path().join("remote.git");
        std::fs::create_dir(&remote_path).unwrap();
        let mut remote = repo.clone();
        remote.path = remote_path.to_string_lossy().into_owned();
        service
            .run(
                &remote,
                "native-sync-remote-init",
                crate::state::args(&[
                    "init",
                    "--quiet",
                    "--bare",
                    "--initial-branch=main",
                    "--template=",
                ]),
                true,
            )
            .await
            .unwrap();
        for args in [
            vec![
                "remote".into(),
                "add".into(),
                "origin".into(),
                remote.path.clone(),
            ],
            crate::state::args(&[
                "-c",
                "protocol.file.allow=always",
                "push",
                "--quiet",
                "--set-upstream",
                "origin",
                "main",
            ]),
            crate::state::args(&["config", "user.name", "Native Fixture"]),
            crate::state::args(&["config", "user.email", "native@example.invalid"]),
            crate::state::args(&["config", "commit.gpgsign", "false"]),
        ] {
            service
                .run(&repo, "native-sync-prepare", args, true)
                .await
                .unwrap();
        }
        let original = service
            .run(
                &repo,
                "native-sync-original-head",
                crate::state::args(&["rev-parse", "HEAD"]),
                false,
            )
            .await
            .unwrap();
        std::fs::write(Path::new(&repo.path).join("incoming.txt"), b"incoming\n").unwrap();
        for args in [
            crate::state::args(&["add", "--", "incoming.txt"]),
            crate::state::args(&["commit", "--quiet", "--message=incoming"]),
            crate::state::args(&[
                "-c",
                "protocol.file.allow=always",
                "push",
                "--quiet",
                "origin",
                "main",
            ]),
        ] {
            service
                .run(&repo, "native-sync-incoming", args, true)
                .await
                .unwrap();
        }
        let incoming = service
            .run(
                &repo,
                "native-sync-incoming-head",
                crate::state::args(&["rev-parse", "HEAD"]),
                false,
            )
            .await
            .unwrap();
        service
            .run(
                &repo,
                "native-sync-reset-local",
                vec!["reset".into(), "--hard".into(), original.trim().into()],
                true,
            )
            .await
            .unwrap();
        let ready = fixture.path().join("sync-pull-ready");
        let release = fixture.path().join("sync-pull-release");
        let pushed = fixture.path().join("sync-push-started");
        let shell_path = |path: &Path| path.to_string_lossy().replace('\\', "/");
        native_hook(
            &repo,
            "post-merge",
            &format!(
                "#!/bin/sh\nprintf ready > '{}'\nwhile ! test -f '{}'; do sleep 0.02; done\n",
                shell_path(&ready),
                shell_path(&release)
            ),
        );
        native_hook(
            &repo,
            "pre-push",
            &format!("#!/bin/sh\nprintf forbidden > '{}'\n", shell_path(&pushed)),
        );
        publish(&service, &repo);
        let _owner = service.begin_request("native-real-sync").unwrap();
        service
            .bind_repository_request(&repo, "native-real-sync", true)
            .unwrap();
        let action = serde_json::from_value(serde_json::json!({"repoId":repo.id,"requestId":"native-real-sync","kind":"sync","pullMode":"ff-only"})).unwrap();
        let sync_service = service.clone();
        let sync_repo = repo.clone();
        let sync =
            tokio::spawn(async move { sync_service.working_action(&sync_repo, action).await });
        wait_for_native_marker(&ready).await;
        let mut revoked = repo.clone();
        revoked.trusted = false;
        publish(&service, &revoked);
        let error = tokio::time::timeout(Duration::from_secs(5), sync)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert!(
            !pushed.exists(),
            "revocation after pull must not start push"
        );
        assert_eq!(
            service
                .run(
                    &revoked,
                    "native-sync-head-preserved",
                    crate::state::args(&["rev-parse", "HEAD"]),
                    false
                )
                .await
                .unwrap(),
            incoming
        );
        assert!(Path::new(&repo.path).join("incoming.txt").exists());
        std::fs::write(release, b"release").unwrap();
    }

    #[tokio::test]
    async fn native_revoke_does_not_force_kill_an_authorized_detached_external_process() {
        let (fixture, service, repo) = native_fixture().await;
        publish(&service, &repo);
        let _owner = service.begin_request("native-external-handoff").unwrap();
        service
            .bind_repository_request(&repo, "native-external-handoff", true)
            .unwrap();
        let ready = fixture.path().join("external-ready");
        let release = fixture.path().join("external-release");
        #[cfg(windows)]
        let mut command = {
            let executable = PathBuf::from(std::env::var_os("WINDIR").unwrap())
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            let mut command = std::process::Command::new(executable);
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
                .arg(format!("[IO.File]::WriteAllText('{}','ready'); while (-not (Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 20 }}", ready.display(), release.display()));
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "printf ready > \"$1\"; while ! test -f \"$2\"; do sleep 0.02; done",
                    "external-fixture",
                ])
                .arg(&ready)
                .arg(&release);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = service
            .with_repository_authorization(&repo, "native-external-handoff", true, || {
                command.spawn().map_err(AppError::io)
            })
            .unwrap();
        wait_for_native_marker(&ready).await;
        assert!(service
            .active_processes("native-external-handoff")
            .is_empty());
        let mut revoked = repo.clone();
        revoked.trusted = false;
        publish(&service, &revoked);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            child.try_wait().unwrap().is_none(),
            "external user-controlled processes must not be killed by revocation"
        );
        std::fs::write(release, b"user finished").unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[tokio::test]
    async fn native_directory_grant_identity_is_rechecked_even_when_repository_itself_is_unchanged()
    {
        let (fixture, service, repo) = native_fixture().await;
        let scope = fixture.path().join("scope");
        std::fs::create_dir(&scope).unwrap();
        let nested = scope.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let policy = Arc::new(crate::trust::TrustService::load(
            &fixture.path().join("policy"),
            &[],
            &mut Vec::new(),
        ));
        policy
            .directory_rule(scope.to_str().unwrap(), true)
            .unwrap();
        let moved = scope.join("repository");
        std::fs::rename(&repo.path, &moved).unwrap();
        let mut current = repo.clone();
        current.path = crate::state::display_path(&std::fs::canonicalize(&moved).unwrap());
        current.id = current.path.clone();
        current.git_dir = moved.join(".git").to_string_lossy().into_owned();
        current.common_dir = current.git_dir.clone();
        service.set_trust_policy(policy);
        publish(&service, &current);
        let _owner = service.begin_request("native-parent-identity").unwrap();
        service
            .bind_repository_request(&current, "native-parent-identity", true)
            .unwrap();
        service.check_request("native-parent-identity").unwrap();
        let previous_scope = fixture.path().join("previous-scope");
        std::fs::rename(&scope, &previous_scope).unwrap();
        std::fs::create_dir(&scope).unwrap();
        std::fs::rename(previous_scope.join("repository"), &moved).unwrap();
        assert_eq!(
            service
                .check_request("native-parent-identity")
                .unwrap_err()
                .code,
            "AUTHORIZATION_CHANGED"
        );
        assert!(service.request_cancelled("native-parent-identity"));
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
