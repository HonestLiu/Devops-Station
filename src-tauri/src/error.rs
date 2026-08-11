use serde::{Serialize, Serializer};

/// Unified error type for every Tauri command.
///
/// Everything the frontend can receive is flattened into a readable string so
/// the UI never has to pattern-match on backend internals.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH error: {0}")]
    Ssh(String),

    #[error("SFTP error: {0}")]
    Sftp(String),

    #[error("Serial port error: {0}")]
    Serial(String),

    #[error("Bluetooth error: {0}")]
    Ble(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Session `{0}` not found or already closed")]
    SessionNotFound(String),

    #[error("Authentication failed for user `{0}` — check password / private key")]
    AuthFailed(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

// --- Conversions from the crates we depend on ------------------------------

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Sftp(e.to_string())
    }
}

impl From<serialport::Error> for AppError {
    fn from(e: serialport::Error) -> Self {
        AppError::Serial(e.to_string())
    }
}

impl From<btleplug::Error> for AppError {
    fn from(e: btleplug::Error) -> Self {
        AppError::Ble(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Storage(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(e.to_string())
    }
}
