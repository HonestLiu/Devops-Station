//! SFTP file operations layered on top of an existing SSH session.

use std::path::Path;

use russh_sftp::protocol::OpenFlags;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use crate::types::RemoteFile;

const CHUNK: usize = 64 * 1024;

/// Join a remote directory with a child name using POSIX semantics.
/// (`std::path::Path` would produce backslashes when the app runs on Windows.)
pub fn remote_join(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

pub async fn list(session: &SshSession, path: &str) -> AppResult<Vec<RemoteFile>> {
    let sftp = session.sftp().await?;
    let canonical = sftp.canonicalize(path).await.unwrap_or_else(|_| path.into());
    let entries = sftp.read_dir(canonical.clone()).await?;

    let mut files: Vec<RemoteFile> = entries
        .map(|entry| {
            let meta = entry.metadata();
            let name = entry.file_name();
            RemoteFile {
                path: remote_join(&canonical, &name),
                name,
                is_dir: meta.is_dir(),
                is_symlink: meta.is_symlink(),
                size: meta.size.unwrap_or(0),
                modified: meta.mtime.unwrap_or(0) as u64,
                permissions: meta.permissions.unwrap_or(0),
                owner: meta.user.clone(),
                group: meta.group.clone(),
            }
        })
        .filter(|f| f.name != "." && f.name != "..")
        .collect();

    // Directories first, then case-insensitive name order — same as yazi / Finder.
    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

pub async fn realpath(session: &SshSession, path: &str) -> AppResult<String> {
    let sftp = session.sftp().await?;
    Ok(sftp.canonicalize(path).await?)
}

pub async fn mkdir(session: &SshSession, path: &str) -> AppResult<()> {
    let sftp = session.sftp().await?;
    sftp.create_dir(path).await?;
    Ok(())
}

pub async fn remove(session: &SshSession, path: &str, is_dir: bool) -> AppResult<()> {
    let sftp = session.sftp().await?;
    if is_dir {
        sftp.remove_dir(path).await?;
    } else {
        sftp.remove_file(path).await?;
    }
    Ok(())
}

pub async fn rename(session: &SshSession, from: &str, to: &str) -> AppResult<()> {
    let sftp = session.sftp().await?;
    sftp.rename(from, to).await?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// Download a remote file to a local path, emitting `sftp-progress` events.
pub async fn download(
    app: &AppHandle,
    session: &SshSession,
    remote_path: &str,
    local_path: &str,
    transfer_id: &str,
) -> AppResult<()> {
    let sftp = session.sftp().await?;
    let total = sftp.metadata(remote_path).await?.size.unwrap_or(0);
    let file_name = remote_path.rsplit('/').next().unwrap_or(remote_path).to_string();

    let mut remote = sftp.open(remote_path).await?;
    let mut local = tokio::fs::File::create(local_path).await?;

    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;
    loop {
        let n = remote.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(app, transfer_id, &file_name, transferred, total, false, None);
    }
    local.flush().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(())
}

/// Upload a local file into a remote directory.
pub async fn upload(
    app: &AppHandle,
    session: &SshSession,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
) -> AppResult<String> {
    let file_name = Path::new(local_path)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Sftp(format!("invalid local path `{local_path}`")))?
        .to_string();
    let remote_path = remote_join(remote_dir, &file_name);

    let sftp = session.sftp().await?;
    let mut local = tokio::fs::File::open(local_path).await?;
    let total = local.metadata().await.map(|m| m.len()).unwrap_or(0);

    let mut remote = sftp
        .open_with_flags(
            remote_path.clone(),
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await?;

    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;
    loop {
        let n = local.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        remote.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(app, transfer_id, &file_name, transferred, total, false, None);
    }
    remote.flush().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(remote_path)
}

fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    file_name: &str,
    transferred: u64,
    total: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "sftp-progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            file_name: file_name.to_string(),
            transferred,
            total,
            done,
            error,
        },
    );
}
