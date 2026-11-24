use crate::{
    error::{AppError, Result},
    model::*,
    settings::{dialog_title, DialogTitle},
    state::{self, AppState},
    system,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn diagnostics(state: State<'_, AppState>) -> Result<Diagnostics> {
    let repository = Repository {
        id: String::new(),
        path: std::env::temp_dir().to_string_lossy().into_owned(),
        name: String::new(),
        git_dir: String::new(),
        common_dir: String::new(),
        head: None,
        branch: None,
        trusted: false,
        bare: false,
    };
    let output = state
        .git
        .version(&repository, &state.next_id("diagnostics"))
        .await;
    Ok(Diagnostics {
        app_version: env!("CARGO_PKG_VERSION").into(),
        git_version: output.ok().map(|s| s.trim().to_owned()),
        git_path: Some(state.git.git_path().to_string_lossy().into_owned()),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        config_directory: Some(state::display_path(&state.profile_directory)),
        warnings: state.warnings.lock().unwrap().clone(),
        performance_enabled: crate::performance::enabled(),
    })
}

#[tauri::command]
pub async fn check_for_updates(
    state: State<'_, AppState>,
) -> Result<crate::updates::GithubUpdateInfo> {
    state.updates.check().await
}

#[tauri::command]
pub fn get_performance_data(clear: Option<bool>) -> Result<crate::performance::PerformanceData> {
    crate::performance::read(clear.unwrap_or(false)).ok_or_else(|| {
        AppError::new(
            "PERFORMANCE_DISABLED",
            "Performance diagnostics were not enabled at startup.",
        )
    })
}

#[tauri::command]
pub fn load_state(state: State<'_, AppState>) -> PersistedState {
    state.persisted.lock().unwrap().clone()
}

#[tauri::command]
pub async fn save_state(state: State<'_, AppState>, value: PersistedState) -> Result<()> {
    state.save(value)
}

#[tauri::command]
pub async fn pick_repository(
    state: State<'_, AppState>,
    purpose: Option<RepositoryPickerPurpose>,
) -> Result<Option<String>> {
    let title = match purpose.unwrap_or_default() {
        RepositoryPickerPurpose::Repository => DialogTitle::Repository,
        RepositoryPickerPurpose::Directory => DialogTitle::Directory,
    };
    Ok(rfd::AsyncFileDialog::new()
        .set_title(dialog_title(&state, title))
        .set_directory(std::env::current_dir().unwrap_or_else(|_| state.profile_directory.clone()))
        .pick_folder()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn open_repository(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    request_id: Option<String>,
    scope_root: Option<String>,
) -> Result<Repository> {
    state
        .open(&path, request_id.as_deref(), scope_root.as_deref(), &app)
        .await
}

#[tauri::command]
pub async fn probe_repository(
    state: State<'_, AppState>,
    candidate: RepositoryCandidate,
    scope_root: String,
    request_id: String,
) -> Result<state::RepositorySummary> {
    state
        .probe_repository(candidate, scope_root, request_id)
        .await
}

#[tauri::command]
pub fn deactivate_repository(state: State<'_, AppState>, request_id: Option<String>) -> Result<()> {
    state.deactivate(request_id.as_deref())
}

#[tauri::command]
pub fn trust_repository(state: State<'_, AppState>, repo_id: String, trusted: bool) -> Result<()> {
    state.trust(&repo_id, trusted)
}

#[tauri::command]
pub fn get_trust_state(
    state: State<'_, AppState>,
    repo_id: Option<String>,
) -> Result<NativeTrustState> {
    state.get_trust_state(repo_id.as_deref())
}

#[tauri::command]
pub fn set_directory_trust(
    state: State<'_, AppState>,
    path: String,
    trusted: bool,
) -> Result<NativeTrustState> {
    state.set_directory_trust(&path, trusted)
}

#[tauri::command]
pub fn set_repository_trust(
    state: State<'_, AppState>,
    repo_id: String,
    decision: RepositoryTrustDecision,
) -> Result<NativeTrustState> {
    state.set_repository_trust(&repo_id, decision)
}

#[tauri::command]
pub async fn discover_repositories(
    state: State<'_, AppState>,
    path: String,
    depth: usize,
    request_id: Option<String>,
) -> Result<RepositoryDiscovery> {
    state
        .discovery
        .discover(
            state.git.clone(),
            path,
            depth,
            request_id.unwrap_or_else(|| state.next_id("discover")),
        )
        .await
}

#[tauri::command]
pub async fn get_refs(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<Vec<GitRef>> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.refs(&repo, &request_id).await
}

#[tauri::command]
pub async fn get_history(state: State<'_, AppState>, query: HistoryQuery) -> Result<HistoryPage> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    state.git.history(&repo, query).await
}

#[tauri::command]
pub async fn get_working_state(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<WorkingState> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.working_state(&repo, &request_id).await
}

#[tauri::command]
pub async fn get_working_index(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<String> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.working_index(&repo, &request_id).await
}

#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
    request_id: String,
    parent: Option<String>,
) -> Result<CommitDetail> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    let mailmap = crate::settings::effective(&state.persisted.lock().unwrap(), Some(&repo_id))
        .get("mailmap")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    state
        .git
        .commit_detail_fast_with_mailmap(&repo, &oid, &request_id, parent.as_deref(), mailmap)
        .await
}

#[tauri::command]
pub async fn compare_commits(
    state: State<'_, AppState>,
    query: ComparisonQuery,
) -> Result<Vec<ChangedFile>> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    state.git.compare(&repo, query).await
}

#[tauri::command]
pub async fn get_diff(state: State<'_, AppState>, query: DiffQuery) -> Result<DiffResult> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    state.git.diff(&repo, query).await
}

#[tauri::command]
pub async fn get_diff_patch(state: State<'_, AppState>, query: DiffQuery) -> Result<DiffResult> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    state.git.diff_patch(&repo, query).await
}

#[tauri::command]
pub async fn get_file_content(
    state: State<'_, AppState>,
    query: DiffQuery,
    side: String,
) -> Result<DiffResult> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    state.git.content_side(&repo, query, &side).await
}

#[tauri::command]
pub async fn get_stashes(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<Vec<Stash>> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.stashes(&repo, &request_id).await
}

#[tauri::command]
pub async fn get_remotes(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<Vec<Remote>> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.remotes(&repo, &request_id).await
}

#[tauri::command]
pub async fn get_repo_config(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<RepoConfig> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.repo_config(&repo, &request_id).await
}

#[tauri::command]
pub async fn git_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: GitAction,
) -> Result<ActionResult> {
    let _request = state.git.begin_request(&action.request_id)?;
    let repo = state.repository_for_request(&action.repo_id, &action.request_id, true)?;
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before running Git operations.",
        ));
    }
    if action.kind == "rebase" && action.interactive.unwrap_or(false) {
        let session = crate::sessions::start(&app, &state, &repo, &action).await?;
        return Ok(ActionResult {
            output: session.message,
            operation: session.operation,
            preview_token: None,
            session_id: Some(session.id),
            status: Some("started".into()),
        });
    }
    let _transaction = state
        .git
        .repository_transaction(&repo, &action.request_id)
        .await?;
    let result = state.git.action(&repo, action).await;
    let _ = app.emit("repository-changed", &repo.id);
    result
}

#[tauri::command]
pub async fn working_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: WorkingAction,
) -> Result<ActionResult> {
    let _request = state.git.begin_request(&action.request_id)?;
    let repo = state.repository_for_request(&action.repo_id, &action.request_id, true)?;
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before running Git operations.",
        ));
    }
    let _transaction = state
        .git
        .repository_transaction(&repo, &action.request_id)
        .await?;
    let result = state.git.working_action(&repo, action).await;
    let _ = app.emit("repository-changed", &repo.id);
    result
}

#[tauri::command]
pub fn cancel_request(state: State<'_, AppState>, request_id: String) {
    state.cancel_request(&request_id);
}

#[tauri::command]
pub fn open_terminal(state: State<'_, AppState>, repo_id: String) -> Result<()> {
    let request_id = state.next_id("terminal");
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, true)?;
    state
        .git
        .with_repository_authorization(&repo, &request_id, true, || system::terminal(&state, &repo))
}

#[tauri::command]
pub fn open_editor(state: State<'_, AppState>, repo_id: String, path: String) -> Result<()> {
    let request_id = state.next_id("editor");
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, true)?;
    state
        .git
        .with_repository_authorization(&repo, &request_id, true, || {
            system::editor(&state, &repo, &path)
        })
}

#[tauri::command]
pub async fn external_diff(state: State<'_, AppState>, query: DiffQuery) -> Result<()> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    let _transaction = state
        .git
        .repository_transaction(&repo, &query.request_id)
        .await?;
    system::external_diff(&state, &repo, query).await
}

#[tauri::command]
pub fn open_url(url: String) -> Result<()> {
    system::open_url(&url)
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<()> {
    if text.len() > 8 * 1024 * 1024 {
        return Err(AppError::new(
            "CLIPBOARD",
            "Clipboard content exceeds 8 MiB.",
        ));
    }
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(AppError::io)
}

#[tauri::command]
pub async fn export_config(app: AppHandle, repo_id: Option<String>) -> Result<bool> {
    let state = app.state::<AppState>();
    let effective = {
        let persisted = state.persisted.lock().unwrap();
        crate::settings::effective(&persisted, repo_id.as_deref())
    };
    let (settings, _) = crate::settings::shared_settings(&effective)?;
    let value = serde_json::json!({"version":2,"settings":settings});
    let file = rfd::AsyncFileDialog::new()
        .set_title(dialog_title(&state, DialogTitle::Export))
        .set_directory(std::env::current_dir().unwrap_or_else(|_| state.profile_directory.clone()))
        .set_file_name("qgitgraph-settings.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .await;
    if let Some(file) = file {
        std::fs::write(
            file.path(),
            serde_json::to_vec_pretty(&value).map_err(AppError::io)?,
        )
        .map_err(AppError::io)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn import_config(state: State<'_, AppState>) -> Result<Option<ConfigImport>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title(dialog_title(&state, DialogTitle::Import))
        .set_directory(std::env::current_dir().unwrap_or_else(|_| state.profile_directory.clone()))
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let metadata = std::fs::metadata(file.path()).map_err(AppError::io)?;
    if metadata.len() > 256 * 1024 {
        return Err(AppError::new("IMPORT", "Shared settings exceed 256 KiB."));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(file.path()).map_err(AppError::io)?)
            .map_err(AppError::io)?;
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if !matches!(version, 1 | 2) {
        return Err(AppError::new(
            "IMPORT",
            "Unsupported shared configuration version.",
        ));
    }
    let source = value
        .get("settings")
        .or_else(|| value.get("repositorySettings"))
        .ok_or_else(|| AppError::new("IMPORT", "Missing shared settings object."))?;
    let (settings, warnings) = crate::settings::shared_settings(source)?;
    Ok(Some(ConfigImport {
        version: 2,
        settings,
        warnings,
    }))
}

#[tauri::command]
pub async fn get_snapshot(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<RepositorySnapshot> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    let mut snapshot = state.git.snapshot(&repo, &request_id).await?;
    state
        .git
        .check_repository_authorization(&repo, &request_id, false)?;
    let mut repositories = state.repositories.lock().unwrap();
    if let Some(current) = repositories.get(&repo_id) {
        snapshot.repository.trusted = current.trusted;
    }
    repositories.insert(repo_id, snapshot.repository.clone());
    Ok(snapshot)
}
#[tauri::command]
pub async fn get_tag_detail(
    state: State<'_, AppState>,
    repo_id: String,
    target: String,
    request_id: String,
) -> Result<TagDetail> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.tag_detail(&repo, &target, &request_id).await
}
#[tauri::command]
pub async fn get_stash_detail(
    state: State<'_, AppState>,
    repo_id: String,
    selector: String,
    request_id: String,
) -> Result<StashDetail> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.stash_detail(&repo, &selector, &request_id).await
}
#[tauri::command]
pub async fn get_containment(
    state: State<'_, AppState>,
    repo_id: String,
    oid: String,
    request_id: String,
) -> Result<Containment> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.containment(&repo, &oid, &request_id).await
}
#[tauri::command]
pub async fn get_submodules(
    state: State<'_, AppState>,
    repo_id: String,
    request_id: String,
) -> Result<Vec<SubmoduleInfo>> {
    let _request = state.git.begin_request(&request_id)?;
    let repo = state.repository_for_request(&repo_id, &request_id, false)?;
    state.git.submodules(&repo, &request_id).await
}
#[tauri::command]
pub async fn verify_signature(
    state: State<'_, AppState>,
    query: VerifyQuery,
) -> Result<VerificationResult> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    let _transaction = state
        .git
        .repository_transaction(&repo, &query.request_id)
        .await?;
    state.git.verify_signature(&repo, &query).await
}
#[tauri::command]
pub async fn open_snapshot(
    state: State<'_, AppState>,
    query: DiffQuery,
    side: String,
) -> Result<()> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    system::open_snapshot(&state, &repo, query, &side).await
}
#[tauri::command]
pub async fn archive_ref(state: State<'_, AppState>, query: ArchiveQuery) -> Result<bool> {
    let _request = state.git.begin_request(&query.request_id)?;
    let repo = state.repository_for_request(&query.repo_id, &query.request_id, false)?;
    if !repo.trusted {
        return Err(AppError::new(
            "UNTRUSTED",
            "Trust this repository before exporting an archive.",
        ));
    }
    if !matches!(query.format.as_str(), "zip" | "tar") {
        return Err(AppError::new(
            "ARCHIVE",
            "Only ZIP and TAR archives are supported.",
        ));
    }
    let oid = state
        .git
        .resolve_revision(&repo, &query.request_id, &query.target)
        .await?;
    let prefix = query.prefix.as_deref().unwrap_or("");
    if prefix.len() > 200
        || prefix.starts_with(['-', '/', '\\'])
        || prefix.contains("..")
        || prefix.contains(':')
        || prefix.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "ARCHIVE",
            "Invalid archive directory prefix.",
        ));
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title(dialog_title(&state, DialogTitle::Archive))
        .set_file_name(format!("{}-{}.{}", repo.name, &oid[..8], query.format))
        .add_filter("Archive", &[query.format.as_str()])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let _transaction = state
        .git
        .repository_transaction(&repo, &query.request_id)
        .await?;
    let output = state
        .git
        .run_bytes(
            &repo,
            &query.request_id,
            vec![
                "archive".into(),
                format!("--format={}", query.format),
                format!("--prefix={prefix}"),
                oid,
                "--".into(),
            ],
            false,
        )
        .await?;
    state
        .git
        .check_repository_authorization(&repo, &query.request_id, true)?;
    state
        .git
        .with_repository_authorization(&repo, &query.request_id, true, || {
            std::fs::write(file.path(), output).map_err(AppError::io)
        })?;
    Ok(true)
}
