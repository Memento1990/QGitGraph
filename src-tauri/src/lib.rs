#![recursion_limit = "256"]

mod authority;
mod commands;
mod discovery;
pub mod error;
pub mod git;
pub mod model;
mod performance;
mod sessions;
pub mod settings;
mod state;
pub mod system;
mod trust;
mod updates;
pub mod usage;
mod usage_commands;
mod verification;

use state::AppState;
use tauri::Manager;

pub fn run() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let arguments: Vec<std::ffi::OsString> = std::env::args_os().collect();
            performance::initialize(performance::requested(
                arguments
                    .iter()
                    .skip(1)
                    .map(|argument| argument.as_os_str()),
                std::env::var_os("QGITGRAPH_PERF").as_deref(),
            ));
            let profile = arguments
                .iter()
                .skip(1)
                .find_map(|argument| {
                    let value = argument.to_str()?;
                    value
                        .strip_prefix("--profile-dir=")
                        .or_else(|| value.strip_prefix("--test-home="))
                        .map(std::path::PathBuf::from)
                })
                .or_else(|| {
                    arguments
                        .windows(2)
                        .find(|pair| pair[0] == "--profile-dir" || pair[0] == "--test-home")
                        .map(|pair| std::path::PathBuf::from(&pair[1]))
                });
            if profile.as_ref().is_some_and(|path| !path.is_absolute()) {
                return Err("An application profile directory must be absolute.".into());
            }
            let directory = profile.clone().unwrap_or(app.path().app_config_dir()?);
            std::fs::create_dir_all(&directory)?;
            let directory = std::fs::canonicalize(directory)?;
            if directory.join("test-manifest.json").is_file() {
                let manifest: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(directory.join("test-manifest.json"))?)?;
                if manifest
                    .get("profileDirectory")
                    .and_then(|v| v.as_str())
                    .map(std::path::PathBuf::from)
                    .and_then(|path| std::fs::canonicalize(path).ok())
                    .as_ref()
                    != Some(&directory)
                {
                    return Err(
                        "The explicit test manifest does not match the selected profile.".into(),
                    );
                }
            }
            app.manage(AppState::new(directory.clone()));
            app.manage(usage_commands::UsageState::new(directory.clone()));
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .expect("main window configuration");
            let mut builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
            if profile.is_some() {
                builder = builder.data_directory(directory.join("webview2"));
            }
            builder
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(14730))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.state::<AppState>().git.cancel_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::diagnostics,
            commands::check_for_updates,
            commands::get_performance_data,
            usage_commands::usage_status,
            usage_commands::usage_start,
            usage_commands::usage_boundary,
            usage_commands::usage_append,
            commands::load_state,
            commands::save_state,
            commands::pick_repository,
            commands::open_repository,
            commands::probe_repository,
            commands::deactivate_repository,
            commands::trust_repository,
            commands::get_trust_state,
            commands::set_directory_trust,
            commands::set_repository_trust,
            commands::discover_repositories,
            commands::get_refs,
            commands::get_history,
            commands::get_working_state,
            commands::get_working_index,
            commands::get_commit_detail,
            commands::compare_commits,
            commands::get_diff,
            commands::get_diff_patch,
            commands::get_file_content,
            commands::get_stashes,
            commands::get_remotes,
            commands::get_repo_config,
            commands::git_action,
            commands::working_action,
            commands::cancel_request,
            commands::open_terminal,
            commands::open_editor,
            commands::external_diff,
            commands::open_url,
            commands::copy_text,
            commands::export_config,
            commands::import_config,
            commands::get_snapshot,
            commands::get_tag_detail,
            commands::get_stash_detail,
            commands::get_containment,
            commands::get_submodules,
            commands::verify_signature,
            commands::archive_ref,
            commands::open_snapshot,
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize QGitGraph");
    application.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            handle.state::<AppState>().git.cancel_all();
        }
    });
}
