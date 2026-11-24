use crate::error::{AppError, Result};
use crate::usage::{UsageBoundary, UsageEventInput, UsageRecorder, UsageStart, UsageStatus};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// 仅接收由原生启动代码选择的 profile，不暴露日志路径或任意文件接口。
pub struct UsageState {
    profile: PathBuf,
    recorder: Mutex<Option<UsageRecorder>>,
}
impl UsageState {
    pub fn new(profile: PathBuf) -> Self {
        Self {
            profile,
            recorder: Mutex::new(None),
        }
    }
    fn with<T>(
        &self,
        operation: impl FnOnce(&mut UsageRecorder) -> std::result::Result<T, crate::usage::UsageError>,
    ) -> Result<T> {
        let mut recorder = self
            .recorder
            .lock()
            .map_err(|_| AppError::new("USAGE_UNAVAILABLE", "Usage recorder is unavailable."))?;
        if recorder.is_none() {
            *recorder = Some(
                UsageRecorder::new(
                    self.profile.clone(),
                    option_env!("QG_SOURCE_BUILD").unwrap_or("development"),
                    env!("CARGO_PKG_VERSION"),
                )
                .map_err(safe_error)?,
            );
        }
        operation(recorder.as_mut().expect("initialized usage recorder")).map_err(safe_error)
    }
}
fn safe_error(error: crate::usage::UsageError) -> AppError {
    AppError::new(error.code, error.message)
}

#[tauri::command]
pub fn usage_status(state: State<'_, UsageState>) -> Result<UsageStatus> {
    state.with(|recorder| Ok(recorder.status()))
}
#[tauri::command]
pub fn usage_start(state: State<'_, UsageState>, input: UsageStart) -> Result<UsageStatus> {
    state.with(|recorder| recorder.start(input))
}
#[tauri::command]
pub fn usage_boundary(
    state: State<'_, UsageState>,
    boundary: UsageBoundary,
) -> Result<UsageStatus> {
    state.with(|recorder| recorder.boundary(boundary))
}
#[tauri::command]
pub fn usage_append(state: State<'_, UsageState>, event: UsageEventInput) -> Result<UsageStatus> {
    state.with(|recorder| recorder.append(event))
}
