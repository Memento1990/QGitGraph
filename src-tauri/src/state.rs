use crate::{
    error::{AppError, Result},
    git::{supported_git, GitService},
    model::{PersistedState, Repository},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};

pub struct AppState {
    pub git: GitService,
    pub updates: crate::updates::UpdateService,
    pub repositories: Mutex<HashMap<String, Repository>>,
    pub persisted: Mutex<PersistedState>,
    pub state_file: PathBuf,
    pub profile_directory: PathBuf,
    pub warnings: Arc<Mutex<Vec<String>>>,
    persistence_lock: Mutex<()>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    sequence: AtomicU64,
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
        Self {
            git,
            updates: crate::updates::UpdateService::new(),
            state_file,
            profile_directory: directory,
            warnings: Arc::new(Mutex::new(warnings)),
            persisted: Mutex::new(persisted),
            repositories: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            persistence_lock: Mutex::new(()),
            sequence: AtomicU64::new(1),
        }
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

    pub async fn open(&self, path: &str) -> Result<Repository> {
        if path.contains('\0') || path.len() > 32768 {
            return Err(AppError::new("PATH", "Invalid repository directory."));
        }
        let path = std::fs::canonicalize(path).map_err(AppError::io)?;
        if !path.is_dir() {
            return Err(AppError::new("PATH", "Choose a repository directory."));
        }
        let provisional = Repository {
            id: String::new(),
            path: display_path(&path),
            name: String::new(),
            git_dir: String::new(),
            common_dir: String::new(),
            head: None,
            branch: None,
            trusted: false,
            bare: false,
        };
        let request = self.next_id("open");
        let _guard = self.git.begin_request(&request)?;
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
            provisional.path.clone()
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
        let canonical = std::fs::canonicalize(&root).map_err(AppError::io)?;
        if !canonical.is_dir() || (!bare && !path.starts_with(&canonical)) {
            return Err(AppError::new(
                "REPOSITORY",
                "Git returned a repository root that does not contain the selected directory.",
            ));
        }
        let root = display_path(&canonical);
        let id = root.clone();
        let mut repo = Repository {
            id: id.clone(),
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
        {
            let mut repositories = self.repositories.lock().unwrap();
            let mut state = self.persisted.lock().unwrap();
            repo.trusted = state.trusted.contains(&root);
            repositories.insert(id, repo.clone());
            state.recent.retain(|r| r.path != root);
            state.recent.insert(
                0,
                crate::model::RecentRepo {
                    path: root.clone(),
                    name: repo.name.clone(),
                },
            );
            state.recent.truncate(30);
            state.last_repo = Some(root);
        }
        self.persist()?;
        Ok(repo)
    }

    pub fn trust(&self, repo_id: &str, trusted: bool) -> Result<()> {
        let mut repositories = self.repositories.lock().unwrap();
        let repo = repositories
            .get_mut(repo_id)
            .ok_or_else(|| AppError::new("REPOSITORY", "Repository is not open."))?;
        repo.trusted = trusted;
        {
            let mut persisted = self.persisted.lock().unwrap();
            persisted.trusted.retain(|p| p != &repo.path);
            if trusted {
                persisted.trusted.push(repo.path.clone());
            }
        }
        drop(repositories);
        self.persist()
    }

    pub fn watch(&self, app: &AppHandle, repo: &Repository) {
        let mut watchers = self.watchers.lock().unwrap();
        watchers.retain(|id, _| id == &repo.id);
        if watchers.contains_key(&repo.id) {
            return;
        }
        drop(watchers);
        let pending = Arc::new(AtomicBool::new(false));
        let app = app.clone();
        let warnings = self.warnings.clone();
        let root = PathBuf::from(&repo.path);
        let git_dir = PathBuf::from(&repo.git_dir);
        let common_dir = PathBuf::from(&repo.common_dir);
        let id = repo.id.clone();
        let callback = move |event: std::result::Result<notify::Event, notify::Error>| {
            let event = match event {
                Ok(event) => Some(event),
                Err(error) => {
                    let mut warnings = warnings.lock().unwrap();
                    // Backend errors can arrive in bursts. Keep one actionable
                    // warning and route their invalidation through the same gate
                    // as file events rather than starting a refresh per error.
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
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                pending.store(false, Ordering::Relaxed);
                let _ = app.emit("repository-changed", id);
            });
        };
        match notify::recommended_watcher(callback) {
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
                        let mut warnings = self.warnings.lock().unwrap();
                        if warnings.len() < 30 {
                            warnings.push(format!(
                                "Cannot watch {}: {error}. Focus or refresh to update.",
                                path.display()
                            ));
                        }
                    }
                }
                self.watchers
                    .lock()
                    .unwrap()
                    .insert(repo.id.clone(), watcher);
            }
            Err(error) => {
                self.warnings.lock().unwrap().push(format!(
                    "Repository watcher unavailable: {error}. Use refresh."
                ));
            }
        }
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

pub fn discover(root: &Path, depth: usize) -> Result<Vec<String>> {
    let root = std::fs::canonicalize(root).map_err(AppError::io)?;
    if depth > 5 {
        return Err(AppError::new(
            "DEPTH",
            "Repository discovery is limited to five directory levels.",
        ));
    }
    let mut found = vec![];
    let mut pending = vec![(root, 0)];
    let mut visited = 0;
    while let Some((directory, level)) = pending.pop() {
        visited += 1;
        if visited > 10_000 || found.len() >= 100 {
            break;
        }
        if directory.join(".git").exists()
            || (directory.join("HEAD").is_file() && directory.join("objects").is_dir())
        {
            found.push(display_path(&directory));
            continue;
        }
        if level >= depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            if matches!(
                entry.file_name().to_str(),
                Some("node_modules" | "target" | ".git" | ".vs" | "$RECYCLE.BIN")
            ) {
                continue;
            }
            pending.push((entry.path(), level + 1));
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let repo = state.open(subdirectory.to_str().unwrap()).await.unwrap();
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
        let reopened = state.open(subdirectory.to_str().unwrap()).await.unwrap();
        assert_eq!(reopened.path, canonical);
        assert_eq!(state.persisted.lock().unwrap().recent.len(), 1);
        let not_repo = directory.path().join("not a repository");
        std::fs::create_dir(&not_repo).unwrap();
        assert_eq!(
            state
                .open(not_repo.to_str().unwrap())
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
        let repo = state.open(root.to_str().unwrap()).await.unwrap();
        assert!(repo.bare);
        assert_eq!(
            repo.path,
            display_path(&std::fs::canonicalize(root).unwrap())
        );
        assert_eq!(
            std::fs::canonicalize(&repo.git_dir).unwrap(),
            std::fs::canonicalize(&repo.path).unwrap()
        );
        assert!(repo.head.is_none());
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
