use serde::Serialize;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn git(detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Self {
            code: "GIT".into(),
            message: "Git could not complete the operation.".into(),
            detail: Some(detail),
        }
    }

    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::new("IO", error.to_string())
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)?;
        if let Some(detail) = &self.detail {
            write!(f, "\n{detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}
