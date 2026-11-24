use crate::{
    error::{AppError, Result},
    git::{supported_git, GitService},
    model::{PersistedState, Repository, RepositoryCandidate, RepositoryMarker, WorkingState},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_REPOSITORY_PROBES: usize = 3;
const REPOSITORY_PROBE_BUDGET: Duration = Duration::from_secs(30);
const MAX_PROBE_MARKER_BYTES: usize = 32768 + 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySummary {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub bare: bool,
    pub trusted: bool,
    pub changes: Option<usize>,
    pub staged: Option<usize>,
    pub unstaged: Option<usize>,
    pub untracked: Option<usize>,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub upstream: Option<String>,
}

struct ProbeRequest {
    git: GitService,
    request_id: String,
    started: Instant,
    timed_out: AtomicBool,
    _request: crate::git::RequestGuard,
    _slot: OwnedSemaphorePermit,
}

impl ProbeRequest {
    fn check(&self) -> Result<()> {
        if self.timed_out.load(Ordering::Acquire)
            || self.started.elapsed() >= REPOSITORY_PROBE_BUDGET
        {
            return Err(AppError::new(
                "TIMEOUT",
                "Repository probe time budget reached.",
            ));
        }
        self.git.check_request(&self.request_id)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ProbeIdentity {
    path: PathBuf,
    volume: u64,
    file: u64,
}

struct ProbeSelection {
    directory: crate::discovery::SelectedDirectory,
    scope: PathBuf,
    identities: Vec<ProbeIdentity>,
    gitfile: Option<Vec<u8>>,
    _pins: Vec<File>,
}

pub struct AppState {
    pub git: GitService,
    pub updates: crate::updates::UpdateService,
    pub repositories: Arc<Mutex<HashMap<String, Repository>>>,
    pub persisted: Arc<Mutex<PersistedState>>,
    pub(crate) discovery: crate::discovery::DiscoveryService,
    trust_rules: Arc<crate::trust::TrustService>,
    trust_changes: Arc<Mutex<()>>,
    probe_slots: Arc<Semaphore>,
    pub state_file: PathBuf,
    pub profile_directory: PathBuf,
    pub warnings: Arc<Mutex<Vec<String>>>,
    persistence_lock: Mutex<()>,
    activation: Arc<Mutex<ActivationState>>,
    watcher_replacement: Arc<Mutex<()>>,
    sequence: AtomicU64,
}

#[derive(Default)]
struct ActivationState {
    generation: u64,
    pending_request: Option<String>,
    active_repository: Option<String>,
    watcher: Option<ActiveWatcher>,
}

struct ActiveWatcher {
    _watcher: Option<RecommendedWatcher>,
    live: Arc<AtomicBool>,
}

impl Drop for ActiveWatcher {
    fn drop(&mut self) {
        self.live.store(false, Ordering::Release);
    }
}

struct ActivationRequest {
    activation: Arc<Mutex<ActivationState>>,
    git: GitService,
    generation: u64,
    request_id: String,
    _request: crate::git::RequestGuard,
    trust_rules: Arc<crate::trust::TrustService>,
    trust_changes: Arc<Mutex<()>>,
}

impl Drop for ActivationRequest {
    fn drop(&mut self) {
        let mut activation = self.activation.lock().unwrap();
        if activation.generation == self.generation
            && activation.pending_request.as_deref() == Some(&self.request_id)
        {
            activation.pending_request = None;
            self.git.cancel(&self.request_id);
        }
    }
}

fn stale_activation() -> AppError {
    AppError::new(
        "CANCELLED",
        "Repository activation was superseded or cancelled.",
    )
}

fn check_activation(activation: &ActivationState, request: &ActivationRequest) -> Result<()> {
    request.git.check_request(&request.request_id)?;
    if activation.generation != request.generation
        || activation.pending_request.as_deref() != Some(&request.request_id)
    {
        return Err(stale_activation());
    }
    Ok(())
}

fn publish_repository(
    request: &ActivationRequest,
    repositories: &Mutex<HashMap<String, Repository>>,
    _persisted: &Mutex<PersistedState>,
    mut repo: Repository,
    watcher: Option<ActiveWatcher>,
) -> Result<Repository> {
    let _trust_change = request.trust_changes.lock().unwrap();
    let identity = if repo.git_dir.is_empty() {
        None
    } else {
        Some(crate::authority::RepositoryIdentity::capture(&repo)?.0)
    };
    let mut activation = request.activation.lock().unwrap();
    check_activation(&activation, request)?;
    let mut records = repositories.lock().unwrap();
    repo.trusted = request.trust_rules.decision(&repo).0;
    request.git.publish_native_repository(&repo, identity);
    records.insert(repo.id.clone(), repo.clone());
    activation.active_repository = Some(repo.id.clone());
    if let Some(watcher) = watcher.as_ref() {
        watcher.live.store(true, Ordering::Release);
    }
    activation.watcher = watcher;
    activation.pending_request = None;
    Ok(repo)
}

impl AppState {
    pub fn new(directory: PathBuf) -> Self {
        let state_file = directory.join("state.json");
        let mut warnings = Vec::new();
        let loaded = match std::fs::metadata(&state_file) {
            Ok(metadata) if metadata.len() > 4 * 1024 * 1024 => Err(AppError::new(
                "STATE",
                "Stored preferences exceed 4 MiB and were not loaded.",
            )),
            Ok(_) => std::fs::read(&state_file)
                .map_err(AppError::io)
                .and_then(|bytes| {
                    serde_json::from_slice::<PersistedState>(&bytes).map_err(AppError::io)
                }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(PersistedState::default())
            }
            Err(error) => Err(AppError::io(error)),
        };
        let config_failed = loaded.is_err();
        let mut config_failed = config_failed;
        let persisted = match loaded.and_then(crate::settings::migrate) {
            Ok(state) => state,
            Err(error) => {
                config_failed = true;
                warnings.push(format!("Preferences were not loaded: {error}. The original state file has not been overwritten."));
                crate::settings::migrate(PersistedState::default()).expect("built-in settings")
            }
        };
        if config_failed && state_file.is_file() {
            let backup = directory.join(format!(
                "state-unreadable-{}.json",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ));
            match std::fs::copy(&state_file, &backup) {
                Ok(_) => warnings.push(format!(
                    "Unreadable preferences were preserved at {} before creating a new state.",
                    display_path(&backup)
                )),
                Err(error) => warnings.push(format!(
                    "Could not preserve unreadable preferences: {error}. Back up {} before saving.",
                    display_path(&state_file)
                )),
            }
        }
        let git = if let Some(home) = test_home(&directory, &mut warnings) {
            GitService::isolated(None, home)
        } else {
            GitService::new(None)
        };
        if let Some(path) = persisted.settings.get("gitPath").and_then(|v| v.as_str()) {
            if let Err(error) = git.set_git_path(path) {
                warnings.push(error.to_string());
            }
        }
        let trust_rules = Arc::new(crate::trust::TrustService::load(
            &directory,
            &persisted.trusted,
            &mut warnings,
        ));
        git.require_native_authorization();
        git.set_trust_policy(trust_rules.clone());
        Self {
            git,
            updates: crate::updates::UpdateService::new(),
            state_file,
            profile_directory: directory,
            warnings: Arc::new(Mutex::new(warnings)),
            persisted: Arc::new(Mutex::new(persisted)),
            repositories: Arc::new(Mutex::new(HashMap::new())),
            discovery: crate::discovery::DiscoveryService::default(),
            trust_rules,
            trust_changes: Arc::new(Mutex::new(())),
            probe_slots: Arc::new(Semaphore::new(MAX_REPOSITORY_PROBES)),
            activation: Arc::new(Mutex::new(ActivationState::default())),
            watcher_replacement: Arc::new(Mutex::new(())),
            persistence_lock: Mutex::new(()),
            sequence: AtomicU64::new(1),
        }
    }

    pub fn profile_directory(&self) -> PathBuf {
        self.profile_directory.clone()
    }

    pub fn next_id(&self, prefix: &str) -> String {
        format!("{prefix}-{}", self.sequence.fetch_add(1, Ordering::Relaxed))
    }

    pub fn repository(&self, id: &str) -> Result<Repository> {
        self.repositories
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "REPOSITORY",
                    "Repository is not open. Open it again before continuing.",
                )
            })
    }

    pub(crate) fn repository_for_request(
        &self,
        id: &str,
        request_id: &str,
        requires_trust: bool,
    ) -> Result<Repository> {
        let repo = self.repository(id)?;
        self.git
            .bind_repository_request(&repo, request_id, requires_trust)?;
        self.git.check_request(request_id)?;
        Ok(repo)
    }

    pub fn persist(&self) -> Result<()> {
        let _write = self.persistence_lock.lock().unwrap();
        let state = self.persisted.lock().unwrap().clone();
        let bytes = serde_json::to_vec_pretty(&state).map_err(AppError::io)?;
        let parent = self
            .state_file
            .parent()
            .ok_or_else(|| AppError::new("STATE", "Invalid application state directory."))?;
        std::fs::create_dir_all(parent).map_err(AppError::io)?;
        let temporary = self.state_file.with_extension("json.tmp");
        std::fs::write(&temporary, bytes).map_err(AppError::io)?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = self
                .state_file
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            unsafe {
                if windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    0x1 | 0x8,
                ) == 0
                {
                    return Err(AppError::io(std::io::Error::last_os_error()));
                }
            }
        }
        #[cfg(not(windows))]
        std::fs::rename(&temporary, &self.state_file).map_err(AppError::io)?;
        Ok(())
    }

    pub fn save(&self, mut next: PersistedState) -> Result<()> {
        next = crate::settings::migrate(next)?;
        let git_path = next
            .settings
            .get("gitPath")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if let Err(error) = self.git.set_git_path(git_path) {
            if !git_path.is_empty() {
                return Err(error);
            }
            let mut warnings = self.warnings.lock().unwrap();
            if !warnings
                .iter()
                .any(|warning| warning.contains("Git is not installed"))
            {
                warnings.push("Git is not installed or discoverable. Preferences can be saved; install Git before opening repositories.".into());
            }
        }
        let previous = {
            let mut persisted = self.persisted.lock().unwrap();
            next.trusted = persisted.trusted.clone();
            let previous = persisted.clone();
            *persisted = next;
            previous
        };
        if let Err(error) = self.persist() {
            let mut persisted = self.persisted.lock().unwrap();
            let trusted = persisted.trusted.clone();
            *persisted = previous;
            persisted.trusted = trusted;
            return Err(error);
        }
        Ok(())
    }

    pub async fn probe_repository(
        &self,
        candidate: RepositoryCandidate,
        scope_root: String,
        request_id: String,
    ) -> Result<RepositorySummary> {
        // A probe owns a normal cancellation token but never starts activation,
        // registers a repository, persists navigation/trust, or builds a watcher.
        let registered = self.git.begin_request(&request_id)?;
        let slot = self
            .probe_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::new("BUSY", "Too many repository probes are running."))?;
        let request = Arc::new(ProbeRequest {
            git: self.git.clone(),
            request_id,
            started: Instant::now(),
            timed_out: AtomicBool::new(false),
            _request: registered,
            _slot: slot,
        });
        let persisted = self.persisted.clone();
        let trust_rules = self.trust_rules.clone();
        let trust_changes = self.trust_changes.clone();
        // Detaching an IPC awaiter cannot free a slot/request while a filesystem
        // worker or Git process is still alive. The actual task owns both and
        // cancels then joins its read-only work when the budget expires.
        tokio::spawn(async move {
            let read = probe_repository_read(
                candidate,
                scope_root,
                persisted,
                trust_rules,
                trust_changes,
                request.clone(),
            );
            tokio::pin!(read);
            tokio::select! { biased;
                result = &mut read => result,
                _ = tokio::time::sleep(REPOSITORY_PROBE_BUDGET) => {
                    request.timed_out.store(true, Ordering::Release);
                    request.git.cancel(&request.request_id);
                    let _ = read.await;
                    request.check()?;
                    unreachable!("expired probe budget must return an error")
                }
            }
        })
        .await
        .map_err(AppError::io)?
    }

    fn begin_activation(&self, request_id: Option<&str>) -> Result<ActivationRequest> {
        let request_id = request_id
            .map(str::to_owned)
            .unwrap_or_else(|| self.next_id("open"));
        // Register before any filesystem, version or Git probe. A renderer
        // cancellation that arrived first must consume its tombstone here.
        let request = self.git.begin_request(&request_id)?;
        let mut activation = self.activation.lock().unwrap();
        self.git.check_request(&request_id)?;
        if let Some(previous) = activation.pending_request.replace(request_id.clone()) {
            self.git.cancel(&previous);
        }
        activation.generation = activation.generation.wrapping_add(1);
        // Keep the current view usable while the candidate is being probed.
        // Only successful publication replaces its watcher; failed/cancelled
        // navigation leaves the active repository intact until deactivation.
        Ok(ActivationRequest {
            activation: self.activation.clone(),
            git: self.git.clone(),
            generation: activation.generation,
            request_id,
            _request: request,
            trust_rules: self.trust_rules.clone(),
            trust_changes: self.trust_changes.clone(),
        })
    }

    pub fn deactivate(&self, request_id: Option<&str>) -> Result<()> {
        let request_id = request_id
            .map(str::to_owned)
            .unwrap_or_else(|| self.next_id("deactivate"));
        let _request = self.git.begin_request(&request_id)?;
        let mut activation = self.activation.lock().unwrap();
        self.git.check_request(&request_id)?;
        activation.generation = activation.generation.wrapping_add(1);
        if let Some(pending) = activation.pending_request.take() {
            self.git.cancel(&pending);
        }
        activation.watcher = None;
        activation.active_repository = None;
        Ok(())
    }

    pub fn cancel_request(&self, request_id: &str) {
        let mut activation = self.activation.lock().unwrap();
        self.git.cancel(request_id);
        if activation.pending_request.as_deref() == Some(request_id) {
            activation.generation = activation.generation.wrapping_add(1);
            activation.pending_request = None;
        }
    }

    pub async fn open(
        &self,
        path: &str,
        request_id: Option<&str>,
        scope_root: Option<&str>,
        app: &AppHandle,
    ) -> Result<Repository> {
        let app = app.clone();
        let warnings = self.warnings.clone();
        self.open_with_watcher(path, request_id, scope_root, move |repo, live| {
            Some(build_watcher(&app, repo, warnings, live))
        })
        .await
    }

    async fn open_with_watcher(
        &self,
        path: &str,
        request_id: Option<&str>,
        scope_root: Option<&str>,
        watcher_factory: impl FnOnce(&Repository, Arc<AtomicBool>) -> Option<ActiveWatcher>
            + Send
            + 'static,
    ) -> Result<Repository> {
        let activation = self.begin_activation(request_id)?;
        let request = activation.request_id.clone();
        let selected = {
            let path = path.to_owned();
            let scope = scope_root.map(str::to_owned);
            let git = self.git.clone();
            let request = request.clone();
            tokio::task::spawn_blocking(move || {
                crate::discovery::select_directory(&path, scope.as_deref(), &mut || {
                    git.check_request(&request)
                })
            })
            .await
            .map_err(AppError::io)??
        };
        self.git.check_request(&request)?;
        let provisional = Repository {
            id: String::new(),
            path: display_path(&selected.path),
            name: String::new(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        };
        let version = self.git.version(&provisional, &request).await?;
        if !supported_git(&version) {
            return Err(AppError::new("GIT_VERSION", "QGitGraph requires Git 2.38 or later. Update Git for Windows or configure a newer git.exe."));
        }
        let discovery = self
            .git
            .run_bytes(
                &provisional,
                &request,
                args(&[
                    "rev-parse",
                    "--path-format=absolute",
                    "--absolute-git-dir",
                    "--git-common-dir",
                    "--is-bare-repository",
                ]),
                false,
            )
            .await?;
        let (git_dir, common_dir, bare) = parse_repository_discovery(&discovery)?;
        let root = if bare {
            // rev-parse can discover a bare repository from one of its own
            // subdirectories too; its administrative root is the repository.
            git_dir.clone()
        } else {
            let output = self
                .git
                .run_bytes(
                    &provisional,
                    &request,
                    args(&["rev-parse", "--show-toplevel"]),
                    false,
                )
                .await?;
            let lines = git_output_lines(&output)?;
            if lines.len() != 1 {
                return Err(repository_output_error());
            }
            absolute_git_path(lines[0])?
        };
        let canonical = {
            let selected = selected.clone();
            let path = path.to_owned();
            let scope = scope_root.map(str::to_owned);
            let root = root.clone();
            let git = self.git.clone();
            let request = request.clone();
            tokio::task::spawn_blocking(move || {
                crate::discovery::validate_repository_root(
                    &selected,
                    &path,
                    scope.as_deref(),
                    &root,
                    bare,
                    &mut || git.check_request(&request),
                )
            })
            .await
            .map_err(AppError::io)??
        };
        let root = display_path(&canonical);
        let mut repo = Repository {
            // 发布前的只读探测不持有任何原生授权。
            id: String::new(),
            path: root.clone(),
            name: canonical
                .file_name()
                .unwrap_or(canonical.as_os_str())
                .to_string_lossy()
                .into_owned(),
            git_dir,
            common_dir,
            head: None,
            branch: None,
            trusted: false,
            bare,
        };
        repo.head = self
            .git
            .run(
                &repo,
                &request,
                args(&["rev-parse", "--verify", "HEAD"]),
                false,
            )
            .await
            .ok()
            .map(|s| s.trim().to_owned());
        repo.branch = self
            .git
            .run(
                &repo,
                &request,
                args(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
                false,
            )
            .await
            .ok()
            .map(|s| s.trim().to_owned());
        self.git.check_request(&request)?;
        repo.id = root.clone();
        let repositories = self.repositories.clone();
        let persisted = self.persisted.clone();
        let replacement = self.watcher_replacement.clone();
        let path = path.to_owned();
        let scope = scope_root.map(str::to_owned);
        // Move activation (including request ownership) into the actual watcher
        // worker. Detached/aborted awaiters cannot revive a stale activation.
        tokio::task::spawn_blocking(move || {
            let _replacement = replacement.lock().unwrap();
            {
                let current = activation.activation.lock().unwrap();
                check_activation(&current, &activation)?;
            }
            let live = Arc::new(AtomicBool::new(false));
            let watcher = watcher_factory(&repo, live);
            // Revalidate the exact scoped marker after Git and watcher probes,
            // just before the generation-guarded publication.
            crate::discovery::validate_repository_root(
                &selected,
                &path,
                scope.as_deref(),
                &root,
                bare,
                &mut || activation.git.check_request(&activation.request_id),
            )?;
            // Opening is read-only navigation. The renderer alone maintains
            // recents/lastRepo; native trust stays authoritative.
            publish_repository(&activation, &repositories, &persisted, repo, watcher)
        })
        .await
        .map_err(AppError::io)?
    }

    #[cfg(test)]
    async fn open_unwatched(
        &self,
        path: &str,
        request_id: Option<&str>,
        scope_root: Option<&str>,
        _: Option<()>,
    ) -> Result<Repository> {
        self.open_with_watcher(path, request_id, scope_root, |_, _| None)
            .await
    }

    pub fn trust(&self, repo_id: &str, trusted: bool) -> Result<()> {
        self.set_repository_trust(
            repo_id,
            if trusted {
                crate::model::RepositoryTrustDecision::Allow
            } else {
                crate::model::RepositoryTrustDecision::Deny
            },
        )
        .map(|_| ())
    }

    fn refresh_native_trust(&self) {
        let mut records = self.repositories.lock().unwrap();
        let mut repositories = self.git.native_repositories();
        for repo in records.values() {
            if !repositories.iter().any(|entry| entry.id == repo.id) {
                repositories.push(repo.clone());
            }
        }
        for mut repo in repositories {
            let unchanged_identity = self.git.validate_native_repository_identity(&repo).is_ok();
            repo.trusted = unchanged_identity && self.trust_rules.decision(&repo).0;
            let identity = crate::authority::RepositoryIdentity::capture(&repo)
                .ok()
                .map(|value| value.0);
            if identity.is_none() {
                repo.trusted = false;
            }
            self.git
                .publish_native_repository(&repo, if unchanged_identity { identity } else { None });
            if let Some(record) = records.get_mut(&repo.id) {
                record.trusted = repo.trusted;
            }
        }
    }

    pub fn get_trust_state(&self, repo_id: Option<&str>) -> Result<crate::model::NativeTrustState> {
        let mut repositories = Vec::new();
        for repo in self.repositories.lock().unwrap().values() {
            if repo_id.is_some_and(|id| id != repo.id) {
                continue;
            }
            let (trusted, source, rule_path) = self.trust_rules.decision(repo);
            let trusted = trusted
                && repo.trusted
                && self.git.validate_native_repository_identity(repo).is_ok();
            repositories.push(crate::model::RepositoryTrust {
                repo_id: repo.id.clone(),
                path: repo.path.clone(),
                trusted,
                source: source.into(),
                rule_path,
                epoch: self.git.native_epoch(&repo.id),
            });
        }
        if repo_id.is_some() && repositories.is_empty() {
            return Err(AppError::new("REPOSITORY", "Repository is not open."));
        }
        repositories.sort_by(|a, b| a.repo_id.cmp(&b.repo_id));
        Ok(self.trust_rules.snapshot(repositories))
    }

    pub fn set_repository_trust(
        &self,
        repo_id: &str,
        decision: crate::model::RepositoryTrustDecision,
    ) -> Result<crate::model::NativeTrustState> {
        let _change = self.trust_changes.lock().unwrap();
        let repo = self.repository(repo_id)?;
        self.git.validate_native_repository_identity(&repo)?;
        let identity = crate::authority::RepositoryIdentity::capture(&repo)?.0;
        let _pins = identity.validate(&repo)?;
        self.trust_rules.repository_rule(&repo, decision)?;
        self.refresh_native_trust();
        // trusted 仅保留旧版兼容镜像；原生规则文件一旦存在就不再二次迁移。
        {
            let mut persisted = self.persisted.lock().unwrap();
            persisted.trusted.retain(|path| path != &repo.path);
            if decision == crate::model::RepositoryTrustDecision::Allow {
                persisted.trusted.push(repo.path.clone());
            }
        }
        self.persist()?;
        self.get_trust_state(None)
    }

    pub fn set_directory_trust(
        &self,
        path: &str,
        trusted: bool,
    ) -> Result<crate::model::NativeTrustState> {
        let _change = self.trust_changes.lock().unwrap();
        self.trust_rules.directory_rule(path, trusted)?;
        self.refresh_native_trust();
        self.get_trust_state(None)
    }
}

fn probe_candidate_error() -> AppError {
    AppError::new(
        "REPOSITORY_SCOPE",
        "The repository candidate changed or is outside the selected directory scope. Refresh the directory tree.",
    )
}

fn probe_io<T>(
    request: &ProbeRequest,
    operation: impl FnOnce() -> std::io::Result<T>,
) -> Result<T> {
    request.check()?;
    let value = operation();
    request.check()?;
    value.map_err(AppError::io)
}

fn probe_is_link(metadata: &Metadata) -> bool {
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

fn pin_probe_path(
    path: &Path,
    directory: bool,
    request: &ProbeRequest,
) -> Result<(File, ProbeIdentity)> {
    let metadata = probe_io(request, || fs::symlink_metadata(path))?;
    if probe_is_link(&metadata)
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.len() > MAX_PROBE_MARKER_BYTES as u64))
    {
        return Err(probe_candidate_error());
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
        // Pin the scope/descendant chain and exact markers without allowing a
        // rename/delete/reparse swap while a read-only Git process uses its cwd.
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = probe_io(request, || options.open(path))?;
    let metadata = probe_io(request, || file.metadata())?;
    if probe_is_link(&metadata)
        || (directory && !metadata.is_dir())
        || (!directory && (!metadata.is_file() || metadata.len() > MAX_PROBE_MARKER_BYTES as u64))
    {
        return Err(probe_candidate_error());
    }
    let canonical = probe_io(request, || fs::canonicalize(path))?;
    if canonical != path {
        return Err(probe_candidate_error());
    }
    #[cfg(windows)]
    let (volume, identity) = {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
            FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        probe_io(request, || {
            if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        })?;
        let mut buffer = vec![0_u16; 32768];
        let length = probe_io(request, || {
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle() as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if length == 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(length)
            }
        })?;
        if length >= buffer.len()
            || std::ffi::OsString::from_wide(&buffer[..length]) != canonical.as_os_str()
        {
            return Err(probe_candidate_error());
        }
        (
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        )
    };
    #[cfg(unix)]
    let (volume, identity) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(any(windows, unix)))]
    let (volume, identity) = (0, 0);
    request.check()?;
    Ok((
        file,
        ProbeIdentity {
            path: canonical,
            volume,
            file: identity,
        },
    ))
}

fn select_probe_candidate(
    candidate: &RepositoryCandidate,
    scope_root: &str,
    request: &ProbeRequest,
) -> Result<ProbeSelection> {
    request.check()?;
    crate::discovery::validate_native_path(&candidate.path)?;
    crate::discovery::validate_native_path(scope_root)?;
    if candidate.components.len() > 5
        || candidate.components.iter().any(|name| {
            name.is_empty()
                || name == "."
                || name == ".."
                || name.len() > 32768
                || name.contains(['/', '\\', ':'])
                || name.chars().any(char::is_control)
        })
    {
        return Err(probe_candidate_error());
    }
    let directory =
        crate::discovery::select_directory(&candidate.path, Some(scope_root), &mut || {
            request.check()
        })?;
    let scope = probe_io(request, || fs::canonicalize(scope_root))?;
    let components: Vec<_> = directory
        .path
        .strip_prefix(&scope)
        .map_err(|_| probe_candidate_error())?
        .components()
        .map(|part| part.as_os_str().to_str().ok_or_else(probe_candidate_error))
        .collect::<Result<_>>()?;
    if components != candidate.components {
        return Err(probe_candidate_error());
    }
    let mut identities = Vec::new();
    let mut pins = Vec::new();
    let mut current = scope.clone();
    let (pin, identity) = pin_probe_path(&current, true, request)?;
    pins.push(pin);
    identities.push(identity);
    for component in components {
        current.push(component);
        let (pin, identity) = pin_probe_path(&current, true, request)?;
        pins.push(pin);
        identities.push(identity);
    }
    let markers: &[(&str, bool)] = match candidate.marker {
        RepositoryMarker::GitDirectory => &[(".git", true)],
        RepositoryMarker::GitFile => &[(".git", false)],
        RepositoryMarker::Bare => &[("HEAD", false), ("objects", true), ("refs", true)],
    };
    if candidate.marker == RepositoryMarker::Bare {
        request.check()?;
        let marker = fs::symlink_metadata(directory.path.join(".git"));
        request.check()?;
        match marker {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(error)),
            Ok(_) => return Err(probe_candidate_error()),
        }
    }
    let mut gitfile = None;
    for (name, is_directory) in markers {
        let (mut pin, identity) =
            pin_probe_path(&directory.path.join(name), *is_directory, request)?;
        if candidate.marker == RepositoryMarker::GitFile {
            let mut bytes = Vec::new();
            probe_io(request, || {
                (&mut pin)
                    .take((MAX_PROBE_MARKER_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
            })?;
            if bytes.len() > MAX_PROBE_MARKER_BYTES {
                return Err(probe_candidate_error());
            }
            gitfile = Some(bytes);
        }
        pins.push(pin);
        identities.push(identity);
    }
    // Repeat the no-reparse/containment checks after obtaining the handles.
    let verified =
        crate::discovery::select_directory(&candidate.path, Some(scope_root), &mut || {
            request.check()
        })?;
    if verified.path != directory.path {
        return Err(probe_candidate_error());
    }
    Ok(ProbeSelection {
        directory,
        scope,
        identities,
        gitfile,
        _pins: pins,
    })
}

fn validate_probe_candidate(
    selected: &ProbeSelection,
    candidate: &RepositoryCandidate,
    scope_root: &str,
    root: Option<&str>,
    bare: bool,
    request: &ProbeRequest,
) -> Result<()> {
    let current = select_probe_candidate(candidate, scope_root, request)?;
    if current.scope != selected.scope
        || current.identities != selected.identities
        || current.gitfile != selected.gitfile
        || bare != (candidate.marker == RepositoryMarker::Bare)
    {
        return Err(probe_candidate_error());
    }
    if let Some(root) = root {
        crate::discovery::validate_repository_root(
            &selected.directory,
            &candidate.path,
            Some(scope_root),
            root,
            bare,
            &mut || request.check(),
        )?;
    }
    request.check()
}

async fn check_probe_candidate(
    selected: Arc<ProbeSelection>,
    candidate: RepositoryCandidate,
    scope_root: String,
    root: Option<String>,
    bare: bool,
    request: Arc<ProbeRequest>,
) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        validate_probe_candidate(
            &selected,
            &candidate,
            &scope_root,
            root.as_deref(),
            bare,
            &request,
        )
    })
    .await
    .map_err(AppError::io)?
}

async fn probe_repository_read(
    candidate: RepositoryCandidate,
    scope_root: String,
    persisted: Arc<Mutex<PersistedState>>,
    trust_rules: Arc<crate::trust::TrustService>,
    trust_changes: Arc<Mutex<()>>,
    request: Arc<ProbeRequest>,
) -> Result<RepositorySummary> {
    let selected = {
        let candidate = candidate.clone();
        let scope = scope_root.clone();
        let request = request.clone();
        Arc::new(
            tokio::task::spawn_blocking(move || {
                select_probe_candidate(&candidate, &scope, &request)
            })
            .await
            .map_err(AppError::io)??,
        )
    };
    let git = &request.git;
    let id = &request.request_id;
    let provisional = Repository {
        id: String::new(),
        path: display_path(&selected.directory.path),
        name: String::new(),
        git_dir: String::new(),
        common_dir: String::new(),
        head: None,
        branch: None,
        trusted: false,
        bare: candidate.marker == RepositoryMarker::Bare,
    };
    let version = git.version(&provisional, id).await?;
    if !supported_git(&version) {
        return Err(AppError::new("GIT_VERSION", "QGitGraph requires Git 2.38 or later. Update Git for Windows or configure a newer git.exe."));
    }
    check_probe_candidate(
        selected.clone(),
        candidate.clone(),
        scope_root.clone(),
        None,
        provisional.bare,
        request.clone(),
    )
    .await?;
    let discovery = git
        .run_bytes(
            &provisional,
            id,
            args(&[
                "rev-parse",
                "--path-format=absolute",
                "--absolute-git-dir",
                "--git-common-dir",
                "--is-bare-repository",
            ]),
            false,
        )
        .await?;
    let (git_dir, common_dir, bare) = parse_repository_discovery(&discovery)?;
    if bare != provisional.bare {
        return Err(probe_candidate_error());
    }
    check_probe_candidate(
        selected.clone(),
        candidate.clone(),
        scope_root.clone(),
        None,
        bare,
        request.clone(),
    )
    .await?;
    let root = if bare {
        git_dir.clone()
    } else {
        let output = git
            .run_bytes(
                &provisional,
                id,
                args(&["rev-parse", "--show-toplevel"]),
                false,
            )
            .await?;
        let lines = git_output_lines(&output)?;
        if lines.len() != 1 {
            return Err(repository_output_error());
        }
        absolute_git_path(lines[0])?
    };
    check_probe_candidate(
        selected.clone(),
        candidate.clone(),
        scope_root.clone(),
        Some(root.clone()),
        bare,
        request.clone(),
    )
    .await?;
    let mut repo = Repository {
        git_dir,
        common_dir,
        bare,
        ..provisional
    };
    // Even read-only status may run attributes' clean/process filters while
    // comparing worktree contents. Until the runner isolates all such helpers,
    // only native-authorized trust may permit a non-bare working-state probe.
    // The untrusted path is strictly rev-parse/symbolic-ref and leaves every
    // worktree/tracking count unknown; renderer settings cannot grant trust.
    let status_authorized = {
        let _change = trust_changes.lock().unwrap();
        let authorized = trust_rules.decision(&repo).0;
        let _ = &persisted;
        repo.id = repo.path.clone();
        repo.trusted = authorized;
        let identity = crate::authority::RepositoryIdentity::capture(&repo)?.0;
        git.publish_native_repository(&repo, Some(identity));
        git.bind_repository_request(&repo, id, false)?;
        authorized
    };
    let working = if status_authorized && !bare {
        match git.working_state(&repo, id).await {
            Ok(working) => Some(working),
            Err(error) if matches!(error.code.as_str(), "CANCELLED" | "TIMEOUT") => {
                return Err(error)
            }
            Err(_) => None,
        }
    } else {
        match probe_head(&repo, &request).await {
            Ok((branch, head)) => {
                repo.branch = branch;
                repo.head = head;
            }
            Err(error) if matches!(error.code.as_str(), "CANCELLED" | "TIMEOUT") => {
                return Err(error)
            }
            Err(_) => {}
        }
        None
    };
    check_probe_candidate(
        selected,
        candidate,
        scope_root,
        Some(root),
        bare,
        request.clone(),
    )
    .await?;
    request.check()?;
    let trusted = trust_rules.decision(&repo).0;
    let working = working.as_ref().filter(|_| trusted);
    Ok(repository_summary(&repo, trusted, working))
}

async fn probe_head(
    repo: &Repository,
    request: &ProbeRequest,
) -> Result<(Option<String>, Option<String>)> {
    request.check()?;
    let output = request
        .git
        .run_output(
            repo,
            &request.request_id,
            args(&["symbolic-ref", "--quiet", "HEAD"]),
            None,
            false,
        )
        .await?;
    let branch = match output.code {
        0 => {
            let lines = git_output_lines(&output.stdout)?;
            if lines.len() != 1 {
                return Err(repository_output_error());
            }
            crate::git::read::validate_revision(lines[0])?;
            lines[0].strip_prefix("refs/heads/").map(str::to_owned)
        }
        1 => None,
        _ => return Err(AppError::git(String::from_utf8_lossy(&output.stderr))),
    };
    request.check()?;
    let output = request
        .git
        .run_output(
            repo,
            &request.request_id,
            args(&[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                "HEAD^{commit}",
            ]),
            None,
            false,
        )
        .await?;
    let head = match output.code {
        0 => {
            let lines = git_output_lines(&output.stdout)?;
            if lines.len() != 1 || !crate::git::parse::is_full_oid(lines[0]) {
                return Err(repository_output_error());
            }
            Some(lines[0].to_owned())
        }
        1 if output.stdout.is_empty() && output.stderr.is_empty() => {
            let output = request
                .git
                .run_output(
                    repo,
                    &request.request_id,
                    args(&["rev-parse", "--revs-only", "--end-of-options", "HEAD"]),
                    None,
                    false,
                )
                .await?;
            if branch.is_none()
                || output.code != 0
                || !output.stdout.is_empty()
                || !output.stderr.is_empty()
            {
                return Err(AppError::git("HEAD does not resolve to an existing commit"));
            }
            None
        }
        _ => return Err(AppError::git(String::from_utf8_lossy(&output.stderr))),
    };
    request.check()?;
    Ok((branch, head))
}

fn repository_summary(
    repo: &Repository,
    trusted: bool,
    working: Option<&WorkingState>,
) -> RepositorySummary {
    let mut summary = RepositorySummary {
        path: repo.path.clone(),
        branch: working.map_or_else(|| repo.branch.clone(), |state| state.branch.clone()),
        head: working.map_or_else(|| repo.head.clone(), |state| state.head.clone()),
        bare: repo.bare,
        trusted,
        changes: None,
        staged: None,
        unstaged: None,
        untracked: None,
        ahead: None,
        behind: None,
        upstream: None,
    };
    let Some(working) = working.filter(|_| !repo.bare) else {
        return summary;
    };
    let mut files: HashMap<&str, (bool, bool, bool, bool)> = HashMap::new();
    for file in &working.files {
        if matches!(file.status.as_str(), "!" | "!!") {
            continue;
        }
        let flags = files.entry(&file.path).or_default();
        flags.0 |= file.staged;
        flags.1 |= file.unstaged
            || file
                .submodule
                .as_ref()
                .is_some_and(|sub| sub.modified || sub.untracked);
        flags.2 |= matches!(file.status.as_str(), "?" | "??");
        flags.3 |= file.status.contains('U') || matches!(file.status.as_str(), "DD" | "AA");
    }
    summary.changes = Some(files.len());
    let (mut staged, mut unstaged, mut untracked) = (0, 0, 0);
    for (is_staged, is_unstaged, is_untracked, conflict) in files.into_values() {
        if conflict {
            continue;
        }
        if is_untracked {
            untracked += 1;
        } else {
            staged += usize::from(is_staged);
            unstaged += usize::from(is_unstaged);
        }
    }
    summary.staged = Some(staged);
    summary.unstaged = Some(unstaged);
    summary.untracked = Some(untracked);
    summary.upstream = working.upstream.clone();
    if working.tracking_known && working.upstream.is_some() && working.branch.is_some() {
        summary.ahead = Some(working.ahead);
        summary.behind = Some(working.behind);
    }
    summary
}

fn build_watcher(
    app: &AppHandle,
    repo: &Repository,
    warnings: Arc<Mutex<Vec<String>>>,
    live: Arc<AtomicBool>,
) -> ActiveWatcher {
    let pending = Arc::new(AtomicBool::new(false));
    let app = app.clone();
    let callback_warnings = warnings.clone();
    let callback_live = live.clone();
    let root = PathBuf::from(&repo.path);
    let git_dir = PathBuf::from(&repo.git_dir);
    let common_dir = PathBuf::from(&repo.common_dir);
    let id = repo.id.clone();
    let callback = move |event: std::result::Result<notify::Event, notify::Error>| {
        if !callback_live.load(Ordering::Acquire) {
            return;
        }
        let event = match event {
            Ok(event) => Some(event),
            Err(error) => {
                let mut warnings = callback_warnings.lock().unwrap();
                // Backend errors can arrive in bursts. Keep one actionable
                // warning and use the same debounce gate as file events.
                if warnings.len() < 30
                    && !warnings
                        .iter()
                        .any(|warning| warning.starts_with("Repository watcher:"))
                {
                    warnings.push(format!(
                        "Repository watcher: {error}. Refresh manually if updates are missed."
                    ));
                }
                None
            }
        };
        if let Some(event) = event {
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            if !event
                .paths
                .iter()
                .any(|path| relevant_change(path, &root, &git_dir, &common_dir))
            {
                return;
            }
        }
        if pending.swap(true, Ordering::Relaxed) {
            return;
        }
        let pending = pending.clone();
        let app = app.clone();
        let id = id.clone();
        let live = callback_live.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            pending.store(false, Ordering::Relaxed);
            if live.load(Ordering::Acquire) {
                let _ = app.emit("repository-changed", id);
            }
        });
    };
    let watcher = match notify::recommended_watcher(callback) {
        Ok(mut watcher) => {
            let mut paths = vec![PathBuf::from(&repo.path)];
            if !Path::new(&repo.git_dir).starts_with(&repo.path) {
                paths.push(PathBuf::from(&repo.git_dir));
            }
            if repo.common_dir != repo.git_dir
                && !Path::new(&repo.common_dir).starts_with(&repo.path)
            {
                paths.push(PathBuf::from(&repo.common_dir));
            }
            for path in paths {
                if let Err(error) = watcher.watch(&path, RecursiveMode::Recursive) {
                    let mut warnings = warnings.lock().unwrap();
                    if warnings.len() < 30 {
                        warnings.push(format!(
                            "Cannot watch {}: {error}. Focus or refresh to update.",
                            path.display()
                        ));
                    }
                }
            }
            Some(watcher)
        }
        Err(error) => {
            let mut warnings = warnings.lock().unwrap();
            if warnings.len() < 30 {
                warnings.push(format!(
                    "Repository watcher unavailable: {error}. Use refresh."
                ));
            }
            None
        }
    };
    ActiveWatcher {
        _watcher: watcher,
        live,
    }
}

fn test_home(directory: &Path, warnings: &mut Vec<String>) -> Option<PathBuf> {
    let manifest_path = directory.join("test-manifest.json");
    if !manifest_path.is_file() {
        return None;
    }
    let result = (|| -> Result<PathBuf> {
        let metadata = std::fs::metadata(&manifest_path).map_err(AppError::io)?;
        if metadata.len() > 64 * 1024 {
            return Err(AppError::new("PROFILE", "Test manifest exceeds 64 KiB."));
        }
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).map_err(AppError::io)?)
                .map_err(AppError::io)?;
        if value.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
            return Err(AppError::new("PROFILE", "Unsupported test manifest."));
        }
        let profile = std::fs::canonicalize(directory).map_err(AppError::io)?;
        let run = profile
            .parent()
            .ok_or_else(|| AppError::new("PROFILE", "Invalid test run directory."))?;
        let advertised = value
            .get("profileDirectory")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::new("PROFILE", "Missing profile directory."))?;
        if std::fs::canonicalize(advertised).map_err(AppError::io)? != profile {
            return Err(AppError::new(
                "PROFILE",
                "Test manifest profile does not match this application profile.",
            ));
        }
        let home = value
            .get("git")
            .and_then(|v| v.get("homeDirectory"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::new("PROFILE", "Missing isolated Git home."))?;
        let home = std::fs::canonicalize(home).map_err(AppError::io)?;
        if !home.starts_with(run) {
            return Err(AppError::new(
                "PROFILE",
                "Test Git home must be inside its run directory.",
            ));
        }
        for key in [
            "xdgConfigDirectory",
            "globalConfig",
            "systemConfig",
            "templateDirectory",
            "hooksDirectory",
        ] {
            let path = value
                .get("git")
                .and_then(|v| v.get(key))
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("PROFILE", format!("Missing isolated Git {key}.")))?;
            if !std::fs::canonicalize(path)
                .map_err(AppError::io)?
                .starts_with(run)
            {
                return Err(AppError::new(
                    "PROFILE",
                    "Test environment path escapes its run directory.",
                ));
            }
        }
        Ok(PathBuf::from(display_path(&home)))
    })();
    match result {
        Ok(home) => Some(home),
        Err(error) => {
            warnings.push(error.to_string());
            None
        }
    }
}

fn repository_output_error() -> AppError {
    AppError::new(
        "GIT_PARSE",
        "Git returned invalid repository discovery output.",
    )
}

/// rev-parse writes LF on Git for Windows too, but accept CRLF from supported
/// installations. Preserve spaces in paths and reject extra/empty records.
fn git_output_lines(output: &[u8]) -> Result<Vec<&str>> {
    let text = std::str::from_utf8(output).map_err(|_| repository_output_error())?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    text.split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() || line.contains(['\0', '\r']) {
                Err(repository_output_error())
            } else {
                Ok(line)
            }
        })
        .collect()
}

fn absolute_git_path(path: &str) -> Result<String> {
    if !Path::new(path).is_absolute() || path.len() > 32768 {
        return Err(repository_output_error());
    }
    Ok(path.to_owned())
}

fn parse_repository_discovery(output: &[u8]) -> Result<(String, String, bool)> {
    let lines = git_output_lines(output)?;
    let [git_dir, common_dir, bare] = lines.as_slice() else {
        return Err(repository_output_error());
    };
    let bare = match *bare {
        "true" => true,
        "false" => false,
        _ => return Err(repository_output_error()),
    };
    Ok((
        absolute_git_path(git_dir)?,
        absolute_git_path(common_dir)?,
        bare,
    ))
}

pub fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_owned()).collect()
}

pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(&text).to_owned()
    }
}

fn relevant_change(path: &Path, root: &Path, git_dir: &Path, common_dir: &Path) -> bool {
    for git in [git_dir, common_dir] {
        if let Ok(relative) = path.strip_prefix(git) {
            let components: Vec<_> = relative
                .components()
                .filter_map(|part| part.as_os_str().to_str())
                .collect();
            if components.is_empty() {
                return true;
            }
            if components.iter().any(|name| name.ends_with(".lock")) {
                return false;
            }
            return matches!(
                components[0],
                "HEAD"
                    | "ORIG_HEAD"
                    | "FETCH_HEAD"
                    | "MERGE_HEAD"
                    | "CHERRY_PICK_HEAD"
                    | "REVERT_HEAD"
                    | "index"
                    | "packed-refs"
                    | "config"
                    | "config.worktree"
                    | "refs"
                    | "rebase-merge"
                    | "rebase-apply"
                    | "sequencer"
                    | "shallow"
            );
        }
    }
    path.starts_with(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_strict_appstate_open_snapshot_history_and_submodules_are_readable_without_trust(
    ) {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let parent = fixture.path().join("parent");
        let source = fixture.path().join("module-source");
        for path in [&home, &parent, &source] {
            fs::create_dir(path).unwrap();
        }
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let setup = GitService::isolated(None, home);
        let mut repo = activation_fixture_repository("setup-parent");
        repo.path = display_path(&parent);
        repo.trusted = true;
        let mut child = repo.clone();
        child.path = display_path(&source);
        for target in [&repo, &child] {
            for arguments in [
                args(&["init", "--quiet", "--initial-branch=main", "--template="]),
                args(&[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "--message=fixture",
                ]),
            ] {
                setup
                    .run(target, "strict-setup", arguments, true)
                    .await
                    .unwrap();
            }
        }
        setup
            .run(
                &repo,
                "strict-submodule-add",
                vec![
                    "-c".into(),
                    "protocol.file.allow=always".into(),
                    "submodule".into(),
                    "add".into(),
                    "--quiet".into(),
                    child.path.clone(),
                    "module".into(),
                ],
                true,
            )
            .await
            .unwrap();
        setup
            .run(
                &repo,
                "strict-parent-commit",
                args(&[
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--quiet",
                    "--message=module",
                ]),
                true,
            )
            .await
            .unwrap();
        let profile = fixture.path().join("profile");
        fs::create_dir(&profile).unwrap();
        let home = fixture.path().join("home");
        for directory in [".config", "template", "hooks"] {
            fs::create_dir(home.join(directory)).unwrap();
        }
        fs::write(home.join("system.gitconfig"), b"").unwrap();
        fs::write(profile.join("test-manifest.json"), serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,"profileDirectory":profile,"git":{
                "homeDirectory":home,"xdgConfigDirectory":home.join(".config"),"globalConfig":home.join(".gitconfig"),
                "systemConfig":home.join("system.gitconfig"),"templateDirectory":home.join("template"),"hooksDirectory":home.join("hooks")
            }
        })).unwrap()).unwrap();
        let state = AppState::new(profile);
        // 不替换 state.git，必须覆盖正式创建时默认开启的原生严格授权。
        let opened = state
            .open_unwatched(&repo.path, Some("strict-native-open"), None, None)
            .await
            .unwrap();
        assert!(!opened.trusted);
        let _snapshot_owner = state.git.begin_request("strict-native-snapshot").unwrap();
        let bound = state
            .repository_for_request(&opened.id, "strict-native-snapshot", false)
            .unwrap();
        let snapshot = state
            .git
            .snapshot(&bound, "strict-native-snapshot")
            .await
            .unwrap();
        assert!(!snapshot.repository.trusted);
        let _history_owner = state.git.begin_request("strict-native-history").unwrap();
        let query = serde_json::from_value(serde_json::json!({"repoId":opened.id,"requestId":"strict-native-history","offset":0,"limit":20})).unwrap();
        assert!(!state
            .git
            .history(&opened, query)
            .await
            .unwrap()
            .commits
            .is_empty());
        let _submodule_owner = state.git.begin_request("strict-native-submodules").unwrap();
        let bound = state
            .repository_for_request(&opened.id, "strict-native-submodules", false)
            .unwrap();
        let submodules = state
            .git
            .submodules(&bound, "strict-native-submodules")
            .await
            .unwrap();
        assert_eq!(submodules.len(), 1);
        assert!(submodules[0].initialized);
        assert!(submodules[0].head.is_some());
        assert!(!state.state_file.exists());
        assert!(state.persisted.lock().unwrap().trusted.is_empty());
    }

    #[tokio::test]
    async fn native_directory_changes_recompute_open_repositories_and_cancel_only_changed_authority(
    ) {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let repo = state
            .open_unwatched(&candidate.path, Some("native-open"), Some(&scope), None)
            .await
            .unwrap();
        assert!(!repo.trusted);
        assert!(state.get_trust_state(None).unwrap().rules.is_empty());
        assert!(!state.state_file.exists());
        let state_dto = state.set_directory_trust(&scope, true).unwrap();
        assert_eq!(state_dto.repositories[0].source, "directory");
        assert!(state_dto.repositories[0].trusted);
        let allowed = state.repository(&repo.id).unwrap();
        let _old = state.git.begin_request("native-directory-old").unwrap();
        state
            .git
            .bind_repository_request(&allowed, "native-directory-old", true)
            .unwrap();
        let before_epoch = state.git.native_epoch(&repo.id);
        state
            .set_repository_trust(&repo.id, crate::model::RepositoryTrustDecision::Deny)
            .unwrap();
        assert!(state.git.request_cancelled("native-directory-old"));
        assert!(!state.repository(&repo.id).unwrap().trusted);
        assert!(state.git.native_epoch(&repo.id) > before_epoch);
        state.set_directory_trust(&scope, false).unwrap();
        state.set_directory_trust(&scope, true).unwrap();
        assert!(!state.repository(&repo.id).unwrap().trusted);
        state
            .set_repository_trust(&repo.id, crate::model::RepositoryTrustDecision::Inherit)
            .unwrap();
        assert!(state.repository(&repo.id).unwrap().trusted);
        assert_eq!(
            state
                .git
                .check_request("native-directory-old")
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        let restarted = AppState::new(state.profile_directory());
        assert!(restarted.trust_rules.decision(&repo).0);
        assert!(restarted.repositories.lock().unwrap().is_empty());
        assert!(restarted.persisted.lock().unwrap().trusted.is_empty());
    }

    #[tokio::test]
    async fn native_save_and_import_json_cannot_create_authority_even_after_restart() {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let repo = state
            .open_unwatched(
                &candidate.path,
                Some("native-json-open"),
                Some(&scope),
                None,
            )
            .await
            .unwrap();
        let mut value = serde_json::to_value(&*state.persisted.lock().unwrap()).unwrap();
        value["trusted"] = serde_json::json!([repo.path]);
        value["nativeTrust"] = serde_json::json!({"version":1,"rules":[{"path":scope,"kind":"directory","decision":"allow"}]});
        value["authorization"] = serde_json::json!({"epoch":999999,"trusted":true});
        state.save(serde_json::from_value(value).unwrap()).unwrap();
        assert!(state.persisted.lock().unwrap().trusted.is_empty());
        assert!(!state.repository(&repo.id).unwrap().trusted);
        assert!(state.get_trust_state(None).unwrap().rules.is_empty());
        let (imported, warnings) = crate::settings::shared_settings(&serde_json::json!({
            "theme":"light", "trusted":[repo.path], "nativeTrust":{"rules":[{"path":scope,"decision":"allow"}]}, "authorization":{"trusted":true,"epoch":42}
        })).unwrap();
        assert_eq!(imported, serde_json::json!({"theme":"light"}));
        assert_eq!(warnings.len(), 3);
        let restarted = AppState::new(state.profile_directory());
        assert!(!restarted.trust_rules.decision(&repo).0);
        let _owner = state.git.begin_request("native-json-write").unwrap();
        let mut forged = repo.clone();
        forged.trusted = true;
        assert!(state
            .git
            .bind_repository_request(&forged, "native-json-write", true)
            .is_err());
        assert!(!Path::new(&repo.git_dir).join("refs/heads/forged").exists());
    }

    #[tokio::test]
    async fn native_rule_change_never_reauthorizes_a_replaced_open_repository_identity() {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let repo = state
            .open_unwatched(
                &candidate.path,
                Some("native-replace-open"),
                Some(&scope),
                None,
            )
            .await
            .unwrap();
        state
            .set_repository_trust(&repo.id, crate::model::RepositoryTrustDecision::Allow)
            .unwrap();
        fs::rename(&repo.git_dir, Path::new(&repo.path).join("old-git")).unwrap();
        fs::create_dir(&repo.git_dir).unwrap();
        assert!(state
            .set_repository_trust(&repo.id, crate::model::RepositoryTrustDecision::Allow)
            .is_err());
        state.set_directory_trust(&scope, true).unwrap();
        assert!(!state.repository(&repo.id).unwrap().trusted);
        assert!(!state.get_trust_state(Some(&repo.id)).unwrap().repositories[0].trusted);
    }

    fn fixture_trust(
        state: &AppState,
        path: &str,
        decision: crate::model::RepositoryTrustDecision,
    ) {
        let mut repo = activation_fixture_repository(path);
        repo.path = path.into();
        state.trust_rules.repository_rule(&repo, decision).unwrap();
    }

    async fn probe_fixture(
        bare: bool,
    ) -> (tempfile::TempDir, AppState, RepositoryCandidate, String) {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let scope = directory.path().join("scope");
        let root = scope.join("repository 中文 with spaces");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(home.join(".gitconfig"), b"").unwrap();
        let mut state = AppState::new(directory.path().join("profile"));
        state.git = GitService::isolated(None, home);
        let mut repo = activation_fixture_repository("probe fixture");
        repo.path = display_path(&root);
        repo.trusted = true;
        let mut init = args(&["init", "--quiet", "--initial-branch=main", "--template="]);
        if bare {
            init.push("--bare".into());
        }
        state
            .git
            .run(&repo, "initialize-probe-fixture", init, true)
            .await
            .unwrap();
        let discovery = state
            .discovery
            .discover(
                state.git.clone(),
                display_path(&scope),
                1,
                "discover-probe-fixture".into(),
            )
            .await
            .unwrap();
        assert_eq!(discovery.repositories.len(), 1);
        let candidate = discovery.repositories.into_iter().next().unwrap();
        (directory, state, candidate, discovery.root)
    }

    fn fixture_probe_request(state: &AppState, id: &str) -> Arc<ProbeRequest> {
        Arc::new(ProbeRequest {
            git: state.git.clone(),
            request_id: id.into(),
            started: Instant::now(),
            timed_out: AtomicBool::new(false),
            _request: state.git.begin_request(id).unwrap(),
            _slot: state.probe_slots.clone().try_acquire_owned().unwrap(),
        })
    }

    fn fixture_files(
        path: &Path,
    ) -> std::collections::BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
        fn visit(
            root: &Path,
            path: &Path,
            files: &mut std::collections::BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
        ) {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let info = fs::symlink_metadata(&path).unwrap();
                assert!(!probe_is_link(&info));
                if info.is_dir() {
                    visit(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root).unwrap().to_owned(),
                        (fs::read(&path).unwrap(), info.modified().unwrap()),
                    );
                }
            }
        }
        let mut files = std::collections::BTreeMap::new();
        visit(path, path, &mut files);
        files
    }

    #[tokio::test]
    async fn probe_is_read_only_and_never_registers_or_changes_active_navigation() {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let existing = state
            .begin_activation(Some("probe-existing-active"))
            .unwrap();
        let live = Arc::new(AtomicBool::new(false));
        publish_repository(
            &existing,
            &state.repositories,
            &state.persisted,
            activation_fixture_repository("existing"),
            Some(ActiveWatcher {
                _watcher: None,
                live: live.clone(),
            }),
        )
        .unwrap();
        drop(existing);
        let pending = state
            .begin_activation(Some("probe-pending-activation"))
            .unwrap();
        let generation = state.activation.lock().unwrap().generation;
        {
            let mut persisted = state.persisted.lock().unwrap();
            persisted.recent.push(crate::model::RecentRepo {
                path: "renderer recent".into(),
                name: "Recent".into(),
            });
            persisted.last_repo = Some("renderer last".into());
            persisted.trusted.push(candidate.path.clone());
            fixture_trust(
                &state,
                &candidate.path,
                crate::model::RepositoryTrustDecision::Allow,
            );
            // The renderer must not be able to grant native trust through settings.
            persisted
                .repo_settings
                .insert("unrelated".into(), serde_json::json!({"trusted":true}));
        }
        let preferences = serde_json::to_value(&*state.persisted.lock().unwrap()).unwrap();
        let files = fixture_files(Path::new(&candidate.path));
        let summary = state
            .probe_repository(
                candidate.clone(),
                scope.clone(),
                "probe-no-activation".into(),
            )
            .await
            .unwrap();
        assert_eq!(summary.path, candidate.path);
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.head.is_none());
        assert!(summary.trusted);
        assert!(!summary.bare);
        assert_eq!(
            (
                summary.changes,
                summary.staged,
                summary.unstaged,
                summary.untracked
            ),
            (Some(0), Some(0), Some(0), Some(0))
        );
        assert_eq!(
            (summary.ahead, summary.behind, summary.upstream),
            (None, None, None)
        );
        assert_eq!(fixture_files(Path::new(&candidate.path)), files);
        assert_eq!(
            serde_json::to_value(&*state.persisted.lock().unwrap()).unwrap(),
            preferences
        );
        assert!(!state.state_file.exists());
        assert_eq!(state.repositories.lock().unwrap().len(), 1);
        assert!(state.repository(&candidate.path).is_err());
        assert!(live.load(Ordering::Acquire));
        {
            let activation = state.activation.lock().unwrap();
            assert_eq!(activation.generation, generation);
            assert_eq!(activation.active_repository.as_deref(), Some("existing"));
            assert_eq!(
                activation.pending_request.as_deref(),
                Some("probe-pending-activation")
            );
            assert!(Arc::ptr_eq(
                &activation.watcher.as_ref().unwrap().live,
                &live
            ));
        }
        assert!(!state.git.request_cancelled("probe-pending-activation"));
        state.persisted.lock().unwrap().trusted.clear();
        fixture_trust(
            &state,
            &candidate.path,
            crate::model::RepositoryTrustDecision::Deny,
        );
        let summary = state
            .probe_repository(candidate, scope, "probe-no-native-trust".into())
            .await
            .unwrap();
        assert!(!summary.trusted);
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.head.is_none());
        assert_eq!(
            (
                summary.changes,
                summary.staged,
                summary.unstaged,
                summary.untracked,
                summary.ahead,
                summary.behind,
                summary.upstream
            ),
            (None, None, None, None, None, None, None)
        );
        drop(pending);
        assert_eq!(state.probe_slots.available_permits(), MAX_REPOSITORY_PROBES);
    }

    #[tokio::test]
    async fn probe_counts_porcelain_files_without_double_counting_untracked_and_reports_tracking() {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let root = Path::new(&candidate.path);
        let mut repo = activation_fixture_repository("probe fixture writes");
        repo.path = candidate.path.clone();
        repo.trusted = true;
        fs::write(root.join("tracked.txt"), b"initial\n").unwrap();
        fs::write(root.join("staged.txt"), b"initial\n").unwrap();
        for values in [
            vec!["add", "--", "tracked.txt", "staged.txt"],
            vec![
                "-c",
                "user.name=Probe Fixture",
                "-c",
                "user.email=probe@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
            vec!["update-ref", "refs/remotes/origin/main", "HEAD"],
            vec!["config", "branch.main.remote", "origin"],
            vec!["config", "branch.main.merge", "refs/heads/main"],
            // Git needs the fetch refspec to map a local tracking ref, not its URL.
            vec![
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        ] {
            state
                .git
                .run(&repo, "prepare-probe-working-fixture", args(&values), true)
                .await
                .unwrap();
        }
        fs::write(root.join("tracked.txt"), b"modified unstaged\n").unwrap();
        fs::write(root.join("staged.txt"), b"modified staged\n").unwrap();
        fs::write(root.join("untracked.txt"), b"new\n").unwrap();
        state
            .git
            .run(
                &repo,
                "stage-probe-working-fixture",
                args(&["add", "--", "staged.txt"]),
                true,
            )
            .await
            .unwrap();
        state
            .persisted
            .lock()
            .unwrap()
            .trusted
            .push(candidate.path.clone());
        fixture_trust(
            &state,
            &candidate.path,
            crate::model::RepositoryTrustDecision::Allow,
        );
        let before = fixture_files(root);
        let summary = state
            .probe_repository(candidate.clone(), scope, "probe-counts".into())
            .await
            .unwrap();
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(crate::git::parse::is_oid(summary.head.as_deref().unwrap()));
        assert_eq!(
            (
                summary.changes,
                summary.staged,
                summary.unstaged,
                summary.untracked
            ),
            (Some(3), Some(1), Some(1), Some(1))
        );
        assert_eq!((summary.ahead, summary.behind), (Some(0), Some(0)));
        assert_eq!(summary.upstream.as_deref(), Some("origin/main"));
        assert!(summary.trusted);
        assert_eq!(fixture_files(root), before);
        assert!(state.repositories.lock().unwrap().is_empty());
        assert!(!state.state_file.exists());
    }

    #[tokio::test]
    async fn probe_bare_and_unreadable_working_state_are_honest_unknowns() {
        let (_fixture, state, candidate, scope) = probe_fixture(true).await;
        let before = fixture_files(Path::new(&candidate.path));
        let summary = state
            .probe_repository(candidate.clone(), scope, "probe-bare".into())
            .await
            .unwrap();
        assert!(summary.bare);
        assert_eq!(summary.branch.as_deref(), Some("main"));
        assert!(summary.head.is_none());
        assert_eq!(
            (
                summary.changes,
                summary.staged,
                summary.unstaged,
                summary.untracked,
                summary.ahead,
                summary.behind
            ),
            (None, None, None, None, None, None)
        );
        assert_eq!(fixture_files(Path::new(&candidate.path)), before);
        assert!(state.repositories.lock().unwrap().is_empty());
        assert!(state.activation.lock().unwrap().watcher.is_none());
        assert_eq!(state.activation.lock().unwrap().generation, 0);

        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        fs::write(
            Path::new(&candidate.path).join(".git/index"),
            b"invalid index fixture",
        )
        .unwrap();
        state
            .persisted
            .lock()
            .unwrap()
            .trusted
            .push(candidate.path.clone());
        fixture_trust(
            &state,
            &candidate.path,
            crate::model::RepositoryTrustDecision::Allow,
        );
        let before = fixture_files(Path::new(&candidate.path));
        let summary = state
            .probe_repository(candidate.clone(), scope, "probe-unknown-index".into())
            .await
            .unwrap();
        assert!(!summary.bare);
        assert!(summary.branch.is_none());
        assert!(summary.head.is_none());
        assert!(summary.changes.is_none());
        assert!(summary.staged.is_none());
        assert!(summary.unstaged.is_none());
        assert!(summary.untracked.is_none());
        assert!(summary.ahead.is_none());
        assert!(summary.behind.is_none());
        assert_eq!(fixture_files(Path::new(&candidate.path)), before);
    }

    #[tokio::test]
    async fn probe_untrusted_status_never_executes_clean_or_process_filters() {
        for filter in ["clean", "process"] {
            let (_fixture, state, candidate, scope) = probe_fixture(false).await;
            let root = Path::new(&candidate.path);
            let mut repo = activation_fixture_repository("malicious probe filter fixture");
            repo.path = candidate.path.clone();
            repo.trusted = true; // Fixture setup is authorized only in this TempDir.
            fs::write(
                root.join(".gitattributes"),
                b"tracked.txt filter=probe-malicious\n",
            )
            .unwrap();
            fs::write(root.join("tracked.txt"), b"aaaa\n").unwrap();
            for values in [
                vec!["config", "core.autocrlf", "false"],
                vec!["add", "--", ".gitattributes", "tracked.txt"],
                vec![
                    "-c",
                    "user.name=Probe Fixture",
                    "-c",
                    "user.email=probe@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=",
                    "commit",
                    "--quiet",
                    "-m",
                    "filter fixture baseline",
                ],
            ] {
                state
                    .git
                    .run(&repo, "prepare-probe-filter-fixture", args(&values), true)
                    .await
                    .unwrap();
            }
            let sentinel_name = format!("probe-{filter}.sentinel");
            let sentinel = root.join(&sentinel_name);
            let command = if filter == "clean" {
                format!("printf probe-clean > {sentinel_name}; cat")
            } else {
                // No successful protocol handshake is needed: execution itself
                // is the violation, and the positive control checks this marker.
                format!("printf probe-process > {sentinel_name}; exit 1")
            };
            state
                .git
                .run(
                    &repo,
                    "configure-probe-filter-fixture",
                    vec![
                        "config".into(),
                        format!("filter.probe-malicious.{filter}"),
                        command,
                    ],
                    true,
                )
                .await
                .unwrap();
            state
                .git
                .run(
                    &repo,
                    "require-probe-filter-fixture",
                    args(&["config", "filter.probe-malicious.required", "true"]),
                    true,
                )
                .await
                .unwrap();
            let tracked = root.join("tracked.txt");
            let original_size = fs::metadata(&tracked).unwrap().len();
            fs::write(&tracked, b"bbbb\n").unwrap();
            assert_eq!(fs::metadata(&tracked).unwrap().len(), original_size);
            // Force a stat-cache miss independent of filesystem clock precision,
            // while keeping the modified worktree file exactly the same length.
            fs::OpenOptions::new()
                .write(true)
                .open(&tracked)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
                )
                .unwrap();
            assert!(!sentinel.exists());
            assert!(state.persisted.lock().unwrap().trusted.is_empty());
            state
                .persisted
                .lock()
                .unwrap()
                .repo_settings
                .insert(candidate.path.clone(), serde_json::json!({"trusted":true}));
            let before = fixture_files(root);
            let summary = state
                .probe_repository(
                    candidate.clone(),
                    scope,
                    format!("probe-untrusted-{filter}"),
                )
                .await
                .unwrap();
            assert!(!summary.trusted);
            assert_eq!(summary.branch.as_deref(), Some("main"));
            assert!(summary.head.is_some());
            assert_eq!(
                (
                    summary.changes,
                    summary.staged,
                    summary.unstaged,
                    summary.untracked,
                    summary.ahead,
                    summary.behind,
                    summary.upstream
                ),
                (None, None, None, None, None, None, None)
            );
            assert!(
                !sentinel.exists(),
                "untrusted probe executed the {filter} filter"
            );
            assert_eq!(fixture_files(root), before);
            assert_eq!(state.activation.lock().unwrap().generation, 0);
            assert!(state.activation.lock().unwrap().watcher.is_none());
            assert!(state.repositories.lock().unwrap().is_empty());
            assert!(!state.state_file.exists());

            // Independent positive control, after the safe probe assertions:
            // raw isolated Git status must execute the configured fixture filter.
            // This proves absence of the sentinel is not an inert filter setup
            // or the runner's separate status gate masking a broken regression.
            let mut control = std::process::Command::new(state.git.git_path());
            control.current_dir(root);
            crate::git::sanitize_environment(&mut control, false, false, state.git.isolated_home());
            let output = control
                .env("GIT_OPTIONAL_LOCKS", "0")
                .env("GIT_TERMINAL_PROMPT", "0")
                .args([
                    "--no-pager",
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "diff.external=",
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "--ahead-behind",
                    "-z",
                    "--untracked-files=all",
                    "--ignore-submodules=none",
                ])
                .output()
                .unwrap();
            assert!(
                sentinel.exists(),
                "raw status did not exercise {filter} filter: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                fs::read(&sentinel).unwrap(),
                format!("probe-{filter}").as_bytes()
            );
        }
    }

    #[tokio::test]
    async fn probe_cancel_before_registration_and_native_capacity_precede_path_or_git_access() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        let invalid = RepositoryCandidate {
            path: "\0invalid".into(),
            components: vec![],
            marker: RepositoryMarker::GitDirectory,
        };
        state.cancel_request("probe-cancel-first");
        assert_eq!(
            state
                .probe_repository(
                    invalid.clone(),
                    "\0scope".into(),
                    "probe-cancel-first".into()
                )
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        let occupied = state
            .probe_slots
            .clone()
            .try_acquire_many_owned(MAX_REPOSITORY_PROBES as u32)
            .unwrap();
        assert_eq!(
            state
                .probe_repository(invalid, "\0scope".into(), "probe-over-capacity".into())
                .await
                .unwrap_err()
                .code,
            "BUSY"
        );
        assert!(state.git.active_processes("probe-over-capacity").is_empty());
        assert!(state.git.begin_request("probe-over-capacity").is_ok());
        drop(occupied);
        assert_eq!(state.probe_slots.available_permits(), MAX_REPOSITORY_PROBES);
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.repositories.lock().unwrap().is_empty());
        assert!(!state.state_file.exists());
    }

    #[tokio::test]
    async fn probe_cancelled_or_aborted_awaiter_retains_blocking_worker_request_and_slot() {
        for abort in [false, true] {
            let (_fixture, state, candidate, scope) = probe_fixture(false).await;
            let state = Arc::new(state);
            let request = fixture_probe_request(&state, "probe-blocked-filesystem");
            let worker_request = request.clone();
            let (entered, entered_rx) = tokio::sync::oneshot::channel();
            let (release, release_rx) = std::sync::mpsc::channel();
            let worker = tokio::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    let selected = select_probe_candidate(&candidate, &scope, &worker_request)?;
                    entered.send(()).unwrap();
                    release_rx.recv().unwrap();
                    validate_probe_candidate(
                        &selected,
                        &candidate,
                        &scope,
                        None,
                        false,
                        &worker_request,
                    )
                })
                .await
                .unwrap()
            });
            entered_rx.await.unwrap();
            drop(request);
            if abort {
                worker.abort();
            }
            state.cancel_request("probe-blocked-filesystem");
            assert_eq!(
                state.probe_slots.available_permits(),
                MAX_REPOSITORY_PROBES - 1
            );
            assert_eq!(
                state
                    .git
                    .begin_request("probe-blocked-filesystem")
                    .err()
                    .unwrap()
                    .code,
                "REQUEST"
            );
            assert!(state
                .git
                .active_processes("probe-blocked-filesystem")
                .is_empty());
            release.send(()).unwrap();
            if abort {
                assert!(worker.await.unwrap_err().is_cancelled());
            } else {
                assert_eq!(worker.await.unwrap().unwrap_err().code, "CANCELLED");
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if state.git.begin_request("probe-blocked-filesystem").is_ok()
                        && state.probe_slots.available_permits() == MAX_REPOSITORY_PROBES
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(state.activation.lock().unwrap().generation, 0);
            assert!(state.repositories.lock().unwrap().is_empty());
            assert!(!state.state_file.exists());
        }
    }

    #[tokio::test]
    async fn probe_rejects_stale_markers_forged_components_and_outside_candidates() {
        let (fixture, state, candidate, scope) = probe_fixture(false).await;
        let mut forged = candidate.clone();
        forged.components = vec!["..".into()];
        assert_eq!(
            state
                .probe_repository(forged, scope.clone(), "probe-forged-components".into())
                .await
                .unwrap_err()
                .code,
            "REPOSITORY_SCOPE"
        );
        let mut forged = candidate.clone();
        forged.components = vec!["different".into()];
        assert_eq!(
            state
                .probe_repository(forged, scope.clone(), "probe-mismatched-components".into())
                .await
                .unwrap_err()
                .code,
            "REPOSITORY_SCOPE"
        );
        let mut forged = candidate.clone();
        forged.marker = RepositoryMarker::GitFile;
        assert_eq!(
            state
                .probe_repository(forged, scope.clone(), "probe-mismatched-marker".into())
                .await
                .unwrap_err()
                .code,
            "REPOSITORY_SCOPE"
        );
        assert_eq!(
            state
                .probe_repository(
                    candidate.clone(),
                    display_path(&fixture.path().join("home")),
                    "probe-outside-scope".into()
                )
                .await
                .unwrap_err()
                .code,
            "REPOSITORY_SCOPE"
        );
        fs::rename(
            Path::new(&candidate.path).join(".git"),
            Path::new(&candidate.path).join("previous-git"),
        )
        .unwrap();
        assert_eq!(
            state
                .probe_repository(candidate, scope, "probe-missing-marker".into())
                .await
                .unwrap_err()
                .code,
            "REPOSITORY"
        );
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.repositories.lock().unwrap().is_empty());
    }

    #[cfg(any(unix, windows))]
    fn probe_directory_alias(target: &Path, alias: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, alias).unwrap();
        #[cfg(windows)]
        {
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
        assert!(probe_is_link(&fs::symlink_metadata(alias).unwrap()));
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn probe_cached_candidates_and_markers_reject_inside_and_outside_reparse_replacements() {
        for outside in [false, true] {
            for marker in [false, true] {
                let (fixture, state, candidate, scope) = probe_fixture(false).await;
                let root = Path::new(&candidate.path);
                let replacement = if outside {
                    fixture.path().join("outside replacement")
                } else {
                    Path::new(&scope).join("replacement")
                };
                fs::create_dir_all(replacement.join(".git")).unwrap();
                let original = if marker {
                    root.join(".git")
                } else {
                    root.to_owned()
                };
                fs::remove_dir_all(&original).unwrap();
                let target = if marker {
                    replacement.join(".git")
                } else {
                    replacement
                };
                probe_directory_alias(&target, &original);
                assert!(state
                    .probe_repository(
                        candidate.clone(),
                        scope,
                        format!("probe-reparse-{outside}-{marker}")
                    )
                    .await
                    .is_err());
                assert_eq!(state.activation.lock().unwrap().generation, 0);
                assert!(state.repositories.lock().unwrap().is_empty());
                assert!(!state.state_file.exists());
                fs::remove_dir(&original).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn probe_pins_current_markers_and_revalidates_gitfile_contents_before_returning() {
        let (_fixture, state, candidate, scope) = probe_fixture(false).await;
        let request = fixture_probe_request(&state, "probe-pinned-marker");
        let selected = select_probe_candidate(&candidate, &scope, &request).unwrap();
        let marker = Path::new(&candidate.path).join(".git");
        let moved = marker.with_file_name("moved-git");
        #[cfg(windows)]
        assert!(fs::rename(&marker, &moved).is_err());
        #[cfg(unix)]
        {
            fs::rename(&marker, &moved).unwrap();
            fs::create_dir(&marker).unwrap();
            assert!(
                validate_probe_candidate(&selected, &candidate, &scope, None, false, &request)
                    .is_err()
            );
            fs::remove_dir(&marker).unwrap();
            fs::rename(&moved, &marker).unwrap();
        }
        drop(selected);
        drop(request);
        fs::rename(&marker, &moved).unwrap();
        fs::write(&marker, format!("gitdir: {}\n", moved.display())).unwrap();
        let mut candidate = candidate;
        candidate.marker = RepositoryMarker::GitFile;
        let request = fixture_probe_request(&state, "probe-gitfile-replacement");
        let selected = select_probe_candidate(&candidate, &scope, &request).unwrap();
        fs::write(&marker, b"gitdir: different-target\n").unwrap();
        assert_eq!(
            validate_probe_candidate(&selected, &candidate, &scope, None, false, &request)
                .unwrap_err()
                .code,
            "REPOSITORY_SCOPE"
        );
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.repositories.lock().unwrap().is_empty());
        let serialized = serde_json::to_value(repository_summary(
            &activation_fixture_repository("unknown"),
            false,
            None,
        ))
        .unwrap();
        for field in [
            "changes",
            "staged",
            "unstaged",
            "untracked",
            "ahead",
            "behind",
            "upstream",
            "branch",
            "head",
        ] {
            assert!(serialized.get(field).unwrap().is_null());
        }
    }

    #[tokio::test]
    async fn probe_supports_gitfile_worktrees_with_external_common_dir_and_root_candidates() {
        let (fixture, state, candidate, _) = probe_fixture(false).await;
        let mut repo = activation_fixture_repository("linked probe fixture");
        repo.path = candidate.path.clone();
        repo.trusted = true;
        state
            .git
            .run(
                &repo,
                "commit-linked-probe-fixture",
                args(&[
                    "-c",
                    "user.name=Probe Fixture",
                    "-c",
                    "user.email=probe@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=",
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "-m",
                    "linked fixture",
                ]),
                true,
            )
            .await
            .unwrap();
        let scope = fixture.path().join("linked scope");
        let linked = scope.join("linked worktree 中文");
        fs::create_dir(&scope).unwrap();
        state
            .git
            .run(
                &repo,
                "add-linked-probe-fixture",
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--quiet".into(),
                    "-b".into(),
                    "linked-probe".into(),
                    display_path(&linked),
                    "HEAD".into(),
                ],
                true,
            )
            .await
            .unwrap();
        let discovery = state
            .discovery
            .discover(
                state.git.clone(),
                display_path(&scope),
                1,
                "discover-linked-probe-fixture".into(),
            )
            .await
            .unwrap();
        let linked_candidate = discovery.repositories.into_iter().next().unwrap();
        assert_eq!(linked_candidate.marker, RepositoryMarker::GitFile);
        let common_before = fixture_files(Path::new(&candidate.path));
        let linked_before = fixture_files(&linked);
        let summary = state
            .probe_repository(
                linked_candidate,
                discovery.root,
                "probe-linked-external-common-dir".into(),
            )
            .await
            .unwrap();
        assert_eq!(summary.branch.as_deref(), Some("linked-probe"));
        assert!(summary.head.is_some());
        assert_eq!(summary.changes, None);
        assert!(!summary.bare);
        assert!(!summary.trusted);
        assert_eq!(fixture_files(Path::new(&candidate.path)), common_before);
        assert_eq!(fixture_files(&linked), linked_before);
        let discovery = state
            .discovery
            .discover(
                state.git.clone(),
                display_path(&linked),
                0,
                "discover-root-probe-fixture".into(),
            )
            .await
            .unwrap();
        assert_eq!(discovery.repositories[0].components.len(), 0);
        let summary = state
            .probe_repository(
                discovery.repositories[0].clone(),
                discovery.root,
                "probe-selected-root-candidate".into(),
            )
            .await
            .unwrap();
        assert_eq!(summary.branch.as_deref(), Some("linked-probe"));
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.activation.lock().unwrap().watcher.is_none());
        assert!(state.repositories.lock().unwrap().is_empty());
        assert!(!state.state_file.exists());
    }

    #[test]
    fn probe_expired_budget_precedes_invalid_filesystem_access() {
        let fixture = tempfile::tempdir().unwrap();
        let state = AppState::new(fixture.path().join("profile"));
        let mut request = fixture_probe_request(&state, "probe-budget-fixture");
        Arc::get_mut(&mut request).unwrap().started = Instant::now() - REPOSITORY_PROBE_BUDGET;
        let invalid = RepositoryCandidate {
            path: "\0invalid".into(),
            components: vec![],
            marker: RepositoryMarker::GitDirectory,
        };
        assert_eq!(
            select_probe_candidate(&invalid, "\0scope", &request)
                .err()
                .unwrap()
                .code,
            "TIMEOUT"
        );
        assert!(state
            .git
            .active_processes("probe-budget-fixture")
            .is_empty());
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.repositories.lock().unwrap().is_empty());
        drop(request);
        assert_eq!(state.probe_slots.available_permits(), MAX_REPOSITORY_PROBES);
        assert!(state.git.begin_request("probe-budget-fixture").is_ok());
    }

    #[test]
    fn watcher_filters_only_git_administrative_noise_not_tracked_named_directories() {
        let root = Path::new("C:/projects/objects/demo");
        let git = root.join(".git");
        assert!(relevant_change(
            &root.join("src/nested/a.txt"),
            root,
            &git,
            &git
        ));
        assert!(relevant_change(
            &root.join("target/tracked.rs"),
            root,
            &git,
            &git
        ));
        assert!(relevant_change(
            &git.join("refs/heads/new"),
            root,
            &git,
            &git
        ));
        assert!(relevant_change(
            &git.join("rebase-merge/done"),
            root,
            &git,
            &git
        ));
        assert!(!relevant_change(
            &git.join("objects/ab/object"),
            root,
            &git,
            &git
        ));
        assert!(!relevant_change(&git.join("index.lock"), root, &git, &git));
        assert!(!relevant_change(
            &git.join("qgitgraph-console.tmp"),
            root,
            &git,
            &git
        ));
    }
    #[test]
    fn profile_manifest_validates_paths_without_passing_verbatim_windows_home_to_git() {
        let run = tempfile::tempdir().unwrap();
        let profile = run.path().join("profile");
        let home = run.path().join("home");
        for path in [
            &profile,
            &home,
            &home.join(".config"),
            &home.join("template"),
            &home.join("hooks"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        for file in [".gitconfig", "system.gitconfig"] {
            std::fs::write(home.join(file), b"").unwrap();
        }
        let value = serde_json::json!({"schemaVersion":1,"profileDirectory":profile,"git":{"homeDirectory":home,"xdgConfigDirectory":home.join(".config"),"globalConfig":home.join(".gitconfig"),"systemConfig":home.join("system.gitconfig"),"templateDirectory":home.join("template"),"hooksDirectory":home.join("hooks")}});
        std::fs::write(
            profile.join("test-manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let mut warnings = Vec::new();
        let selected = test_home(&profile, &mut warnings).unwrap();
        assert!(warnings.is_empty());
        assert!(!selected.to_string_lossy().starts_with("\\\\?\\"));
        assert_eq!(
            std::fs::canonicalize(selected).unwrap(),
            std::fs::canonicalize(home).unwrap()
        );
    }
    #[test]
    fn save_uses_authoritative_trust_and_failed_writes_preserve_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_owned());
        let mut next = state.persisted.lock().unwrap().clone();
        next.trusted = vec!["attacker supplied".into()];
        next.settings["theme"] = serde_json::json!("light");
        state.save(next).unwrap();
        assert!(state.persisted.lock().unwrap().trusted.is_empty());
        assert_eq!(state.persisted.lock().unwrap().settings["theme"], "light");
        std::fs::create_dir(state.state_file.with_extension("json.tmp")).unwrap();
        let mut next = state.persisted.lock().unwrap().clone();
        next.settings["theme"] = serde_json::json!("dark");
        assert!(state.save(next).is_err());
        assert_eq!(state.persisted.lock().unwrap().settings["theme"], "light");
    }
    #[test]
    fn damaged_preferences_are_backed_up_before_new_state_is_saved() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("state.json"), b"{ damaged").unwrap();
        let state = AppState::new(directory.path().to_owned());
        assert!(!state.warnings.lock().unwrap().is_empty());
        let backup = std::fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("state-unreadable-")
            })
            .unwrap();
        assert_eq!(std::fs::read(backup.path()).unwrap(), b"{ damaged");
        state.persist().unwrap();
        assert_eq!(std::fs::read(backup.path()).unwrap(), b"{ damaged");
    }
    #[test]
    fn discovery_requires_three_records_absolute_paths_and_exact_bare_flag() {
        let directory = tempfile::tempdir().unwrap();
        let git = directory.path().join("git directory with spaces");
        let common = directory.path().join("common directory");
        for newline in ["\n", "\r\n"] {
            let output = format!(
                "{}{newline}{}{newline}false{newline}",
                git.display(),
                common.display()
            );
            let parsed = parse_repository_discovery(output.as_bytes()).unwrap();
            assert_eq!(
                parsed,
                (
                    git.to_string_lossy().into_owned(),
                    common.to_string_lossy().into_owned(),
                    false
                )
            );
        }
        for output in [
            format!("{}\n{}\nmaybe\n", git.display(), common.display()),
            format!("relative\n{}\ntrue\n", common.display()),
            format!("{}\n{}\ntrue\nextra\n", git.display(), common.display()),
            format!("{}\n{}\ntrue\n\n", git.display(), common.display()),
            format!("{}\rbroken\n{}\ntrue\n", git.display(), common.display()),
            format!("{}\n\ntrue\n", git.display()),
        ] {
            assert_eq!(
                parse_repository_discovery(output.as_bytes())
                    .unwrap_err()
                    .code,
                "GIT_PARSE"
            );
        }
        assert!(parse_repository_discovery(b"\xff\n/path\nfalse\n").is_err());
    }
    #[tokio::test]
    async fn open_canonicalizes_selected_subdirectories_and_preserves_authoritative_trust() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let root = directory.path().join("repository with spaces 中文");
        let subdirectory = root.join("nested/directory");
        for path in [&home, &subdirectory] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(home.join(".gitconfig"), b"").unwrap();
        let mut state = AppState::new(directory.path().join("profile"));
        state.git = GitService::isolated(None, home);
        let provisional = Repository {
            id: String::new(),
            path: display_path(&root),
            name: String::new(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        };
        state
            .git
            .run(
                &provisional,
                "initialize-open-fixture",
                args(&["init", "--quiet", "--initial-branch=main", "--template="]),
                false,
            )
            .await
            .unwrap();
        let canonical = display_path(&std::fs::canonicalize(&root).unwrap());
        state
            .persisted
            .lock()
            .unwrap()
            .trusted
            .push(canonical.clone());
        fixture_trust(
            &state,
            &canonical,
            crate::model::RepositoryTrustDecision::Allow,
        );
        {
            let mut persisted = state.persisted.lock().unwrap();
            persisted.recent.push(crate::model::RecentRepo {
                path: "renderer-owned-recent".into(),
                name: "Previous".into(),
            });
            persisted.last_repo = Some("renderer-owned-last".into());
        }
        let navigation_before = serde_json::to_value(&*state.persisted.lock().unwrap()).unwrap();
        let repo = state
            .open_unwatched(subdirectory.to_str().unwrap(), None, None, None)
            .await
            .unwrap();
        assert_eq!(repo.path, canonical);
        assert_eq!(repo.id, canonical);
        assert!(repo.trusted);
        assert!(!repo.bare);
        assert!(repo.head.is_none());
        assert_eq!(repo.branch.as_deref(), Some("main"));
        assert_eq!(
            std::fs::canonicalize(&repo.git_dir).unwrap(),
            std::fs::canonicalize(root.join(".git")).unwrap()
        );
        assert_eq!(repo.git_dir, repo.common_dir);
        let reopened = state
            .open_unwatched(subdirectory.to_str().unwrap(), None, None, None)
            .await
            .unwrap();
        assert_eq!(reopened.path, canonical);
        assert_eq!(state.persisted.lock().unwrap().recent.len(), 1);
        assert_eq!(
            state.persisted.lock().unwrap().recent[0].path,
            "renderer-owned-recent"
        );
        assert_eq!(
            serde_json::to_value(&*state.persisted.lock().unwrap()).unwrap(),
            navigation_before
        );
        assert!(!state.state_file.exists());
        // Ordinary subdirectory opening remains available, but scoped tree
        // opening must never fall back to an ancestor after a marker disappears.
        assert!(state
            .open_unwatched(
                subdirectory.to_str().unwrap(),
                Some("scope-missing-marker"),
                Some(root.to_str().unwrap()),
                None
            )
            .await
            .is_err());
        let nested = root.join("nested repo");
        std::fs::create_dir(&nested).unwrap();
        let mut nested_provisional = provisional.clone();
        nested_provisional.path = display_path(&nested);
        state
            .git
            .run(
                &nested_provisional,
                "initialize-nested-open-fixture",
                args(&["init", "--quiet", "--initial-branch=main", "--template="]),
                false,
            )
            .await
            .unwrap();
        let scoped = state
            .open_unwatched(
                nested.to_str().unwrap(),
                Some("scope-exact"),
                Some(root.to_str().unwrap()),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            scoped.path,
            display_path(&std::fs::canonicalize(&nested).unwrap())
        );
        assert!(!scoped.trusted);
        std::fs::remove_dir_all(nested.join(".git")).unwrap();
        assert!(state
            .open_unwatched(
                nested.to_str().unwrap(),
                Some("scope-removed"),
                Some(root.to_str().unwrap()),
                None
            )
            .await
            .is_err());
        let fallback = state
            .open_unwatched(
                nested.to_str().unwrap(),
                Some("ordinary-subdir"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(fallback.path, canonical);
        state.deactivate(Some("deactivate-open-fixture")).unwrap();
        assert!(state.activation.lock().unwrap().active_repository.is_none());
        assert!(state.repository(&repo.id).unwrap().trusted);
        let not_repo = directory.path().join("not a repository");
        std::fs::create_dir(&not_repo).unwrap();
        assert_eq!(
            state
                .open_unwatched(not_repo.to_str().unwrap(), None, None, None)
                .await
                .unwrap_err()
                .code,
            "GIT"
        );
    }
    #[tokio::test]
    async fn bare_open_does_not_require_a_worktree_root() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let root = directory.path().join("bare repository.git");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(home.join(".gitconfig"), b"").unwrap();
        let mut state = AppState::new(directory.path().join("profile"));
        state.git = GitService::isolated(None, home);
        let provisional = Repository {
            id: String::new(),
            path: display_path(&root),
            name: String::new(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        };
        state
            .git
            .run(
                &provisional,
                "initialize-bare-open-fixture",
                args(&[
                    "init",
                    "--bare",
                    "--quiet",
                    "--initial-branch=main",
                    "--template=",
                ]),
                false,
            )
            .await
            .unwrap();
        let repo = state
            .open_unwatched(root.to_str().unwrap(), None, None, None)
            .await
            .unwrap();
        assert!(repo.bare);
        assert_eq!(
            repo.path,
            display_path(&std::fs::canonicalize(root).unwrap())
        );
        assert_eq!(
            std::fs::canonicalize(&repo.git_dir).unwrap(),
            std::fs::canonicalize(&repo.path).unwrap()
        );
        let ordinary_subdirectory = state
            .open_unwatched(
                Path::new(&repo.path).join("objects").to_str().unwrap(),
                Some("bare-subdirectory"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(ordinary_subdirectory.path, repo.path);
        assert!(ordinary_subdirectory.bare);
        assert!(repo.head.is_none());
    }
    fn activation_fixture_repository(id: &str) -> Repository {
        Repository {
            id: id.into(),
            path: id.into(),
            name: id.into(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        }
    }

    #[test]
    fn native_generation_rejects_late_commits_and_replaces_only_one_live_watcher() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        let first = state.begin_activation(Some("open-first")).unwrap();
        let first_live = Arc::new(AtomicBool::new(false));
        let second = state.begin_activation(Some("open-second")).unwrap();
        assert!(state.git.request_cancelled("open-first"));
        assert_eq!(
            publish_repository(
                &first,
                &state.repositories,
                &state.persisted,
                activation_fixture_repository("first"),
                Some(ActiveWatcher {
                    _watcher: None,
                    live: first_live.clone()
                })
            )
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        assert!(!first_live.load(Ordering::Acquire));
        assert!(state.repositories.lock().unwrap().is_empty());
        let second_live = Arc::new(AtomicBool::new(false));
        let second_path = directory.path().join("second");
        fs::create_dir(&second_path).unwrap();
        let second_path = display_path(&fs::canonicalize(second_path).unwrap());
        fixture_trust(
            &state,
            &second_path,
            crate::model::RepositoryTrustDecision::Allow,
        );
        let mut second_fixture = activation_fixture_repository("second");
        second_fixture.path = second_path;
        let second_repo = publish_repository(
            &second,
            &state.repositories,
            &state.persisted,
            second_fixture,
            Some(ActiveWatcher {
                _watcher: None,
                live: second_live.clone(),
            }),
        )
        .unwrap();
        assert!(second_repo.trusted);
        assert!(second_live.load(Ordering::Acquire));
        drop(first);
        assert_eq!(
            state
                .activation
                .lock()
                .unwrap()
                .active_repository
                .as_deref(),
            Some("second")
        );
        drop(second);
        assert_eq!(
            state
                .activation
                .lock()
                .unwrap()
                .active_repository
                .as_deref(),
            Some("second")
        );
        let third = state.begin_activation(Some("open-third")).unwrap();
        assert!(second_live.load(Ordering::Acquire));
        assert!(state.activation.lock().unwrap().watcher.is_some());
        assert_eq!(
            state
                .activation
                .lock()
                .unwrap()
                .active_repository
                .as_deref(),
            Some("second")
        );
        let third_live = Arc::new(AtomicBool::new(false));
        publish_repository(
            &third,
            &state.repositories,
            &state.persisted,
            activation_fixture_repository("third"),
            Some(ActiveWatcher {
                _watcher: None,
                live: third_live.clone(),
            }),
        )
        .unwrap();
        assert!(!second_live.load(Ordering::Acquire));
        assert!(third_live.load(Ordering::Acquire));
        state.deactivate(Some("close-active")).unwrap();
        assert!(!third_live.load(Ordering::Acquire));
        assert!(state.activation.lock().unwrap().watcher.is_none());
        assert!(state.activation.lock().unwrap().active_repository.is_none());
        // External sessions can still address earlier repository records.
        assert!(state.repository("second").unwrap().trusted);
        assert!(state.repository("third").is_ok());
        assert!(!state.state_file.exists());
    }

    #[tokio::test]
    async fn failed_open_preserves_active_repository_and_its_live_watcher() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        let activation = state.begin_activation(Some("existing-active")).unwrap();
        let live = Arc::new(AtomicBool::new(false));
        let repo = publish_repository(
            &activation,
            &state.repositories,
            &state.persisted,
            activation_fixture_repository("existing"),
            Some(ActiveWatcher {
                _watcher: None,
                live: live.clone(),
            }),
        )
        .unwrap();
        drop(activation);
        let invalid = directory.path().join("missing candidate");
        let error = state
            .open_unwatched(
                invalid.to_str().unwrap(),
                Some("failed-candidate"),
                None,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "IO");
        assert!(live.load(Ordering::Acquire));
        {
            let active = state.activation.lock().unwrap();
            assert_eq!(active.active_repository.as_deref(), Some(repo.id.as_str()));
            assert!(Arc::ptr_eq(&active.watcher.as_ref().unwrap().live, &live));
            assert!(active.pending_request.is_none());
        }
        assert_eq!(state.repository(&repo.id).unwrap().id, repo.id);
        assert_eq!(state.repositories.lock().unwrap().len(), 1);
        assert!(!state.state_file.exists());
    }

    #[test]
    fn cancelling_or_abandoning_pending_activation_preserves_existing_active_watcher() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        let existing = state.begin_activation(Some("existing-for-cancel")).unwrap();
        let live = Arc::new(AtomicBool::new(false));
        publish_repository(
            &existing,
            &state.repositories,
            &state.persisted,
            activation_fixture_repository("existing"),
            Some(ActiveWatcher {
                _watcher: None,
                live: live.clone(),
            }),
        )
        .unwrap();
        drop(existing);
        let pending = state.begin_activation(Some("cancel-pending-only")).unwrap();
        state.cancel_request("cancel-pending-only");
        assert!(live.load(Ordering::Acquire));
        assert_eq!(
            state
                .activation
                .lock()
                .unwrap()
                .active_repository
                .as_deref(),
            Some("existing")
        );
        assert_eq!(
            publish_repository(
                &pending,
                &state.repositories,
                &state.persisted,
                activation_fixture_repository("cancelled"),
                None
            )
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        drop(pending);
        let abandoned = state
            .begin_activation(Some("abandoned-pending-only"))
            .unwrap();
        drop(abandoned);
        assert!(live.load(Ordering::Acquire));
        {
            let active = state.activation.lock().unwrap();
            assert_eq!(active.active_repository.as_deref(), Some("existing"));
            assert!(Arc::ptr_eq(&active.watcher.as_ref().unwrap().live, &live));
            assert!(active.pending_request.is_none());
        }
        assert_eq!(state.repositories.lock().unwrap().len(), 1);
        state.deactivate(Some("explicit-close-existing")).unwrap();
        assert!(!live.load(Ordering::Acquire));
        assert!(state.activation.lock().unwrap().watcher.is_none());
        assert!(state.activation.lock().unwrap().active_repository.is_none());
    }

    #[test]
    fn deactivate_cancel_and_aborted_activation_invalidate_pending_publication() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        let pending = state
            .begin_activation(Some("pending-before-close"))
            .unwrap();
        state.deactivate(None).unwrap();
        assert!(state.git.request_cancelled("pending-before-close"));
        assert_eq!(
            publish_repository(
                &pending,
                &state.repositories,
                &state.persisted,
                activation_fixture_repository("late"),
                None
            )
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        drop(pending);
        let cancelled = state.begin_activation(Some("cancelled-open")).unwrap();
        state.cancel_request("cancelled-open");
        assert_eq!(
            publish_repository(
                &cancelled,
                &state.repositories,
                &state.persisted,
                activation_fixture_repository("cancelled"),
                None
            )
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        drop(cancelled);
        let aborted = state.begin_activation(Some("aborted-open")).unwrap();
        let generation = aborted.generation;
        drop(aborted);
        assert!(state.activation.lock().unwrap().pending_request.is_none());
        assert_eq!(state.activation.lock().unwrap().generation, generation);
        assert!(state.repositories.lock().unwrap().is_empty());
        assert!(state.git.begin_request("aborted-open").is_ok());
    }

    #[tokio::test]
    async fn blocked_actual_watcher_worker_cannot_commit_after_deactivate_or_new_open() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("home");
        let root = directory.path().join("repository");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(home.join(".gitconfig"), b"").unwrap();
        let mut state = AppState::new(directory.path().join("profile"));
        state.git = GitService::isolated(None, home);
        let mut provisional = activation_fixture_repository("fixture");
        provisional.path = display_path(&root);
        state
            .git
            .run(
                &provisional,
                "initialize-race-fixture",
                args(&["init", "--quiet", "--initial-branch=main", "--template="]),
                false,
            )
            .await
            .unwrap();
        let state = Arc::new(state);
        let worker_state = state.clone();
        let worker_root = root.clone();
        let live = Arc::new(AtomicBool::new(false));
        let worker_live = live.clone();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let old = tokio::spawn(async move {
            worker_state
                .open_with_watcher(
                    worker_root.to_str().unwrap(),
                    Some("blocked-activation"),
                    None,
                    move |_, _| {
                        entered.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Some(ActiveWatcher {
                            _watcher: None,
                            live: worker_live,
                        })
                    },
                )
                .await
        });
        entered_rx.await.unwrap();
        // A blocked native watcher setup never holds the activation-generation
        // lock. Deactivate is prompt and cannot be undone by that worker.
        state.deactivate(Some("close-blocked-activation")).unwrap();
        assert!(state.git.request_cancelled("blocked-activation"));
        assert!(state.activation.lock().unwrap().active_repository.is_none());
        assert!(state.repositories.lock().unwrap().is_empty());
        let newer_state = state.clone();
        let newer_root = root.clone();
        let newer = tokio::spawn(async move {
            newer_state
                .open_unwatched(
                    newer_root.to_str().unwrap(),
                    Some("newer-activation"),
                    None,
                    None,
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if state.activation.lock().unwrap().pending_request.as_deref()
                    == Some("newer-activation")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release.send(()).unwrap();
        assert_eq!(old.await.unwrap().unwrap_err().code, "CANCELLED");
        assert!(!live.load(Ordering::Acquire));
        let newer_repo = newer.await.unwrap().unwrap();
        assert_eq!(
            state
                .activation
                .lock()
                .unwrap()
                .active_repository
                .as_deref(),
            Some(newer_repo.id.as_str())
        );
        assert_eq!(state.repositories.lock().unwrap().len(), 1);
        assert!(!state.state_file.exists());
    }

    #[tokio::test]
    async fn cancel_before_open_registration_wins_before_invalid_path_or_git_probes() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().join("profile"));
        state.git.cancel("cancel-first-open");
        assert_eq!(
            state
                .open_unwatched("\0invalid", Some("cancel-first-open"), None, None)
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(state.repositories.lock().unwrap().is_empty());
        state.git.cancel("cancel-first-close");
        assert_eq!(
            state
                .deactivate(Some("cancel-first-close"))
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert_eq!(state.activation.lock().unwrap().generation, 0);
        assert!(!state.state_file.exists());
    }

    #[test]
    fn validates_minimum_git_without_assuming_suffix() {
        assert!(supported_git("git version 2.47.0.windows.2\n"));
        assert!(supported_git("git version 2.38.0"));
        assert!(supported_git("git version 3.0.0"));
        assert!(!supported_git("git version 2.37.9"));
        assert!(!supported_git("not git"));
    }
}
