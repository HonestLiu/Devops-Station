//! SFTP file operations layered on top of an existing SSH session.

use std::io::SeekFrom;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::ssh::SshSession;
use crate::types::{RemoteFile, RemoteFileMeta};

/// Cap on inline file editing — files larger than this must be downloaded.
const EDIT_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Cap on in-app binary previews (images, PDF, video, audio). Beyond this we
/// don't pull the file through the IPC channel base64 — the UI falls back to a
/// plain download instead.
const PREVIEW_MAX_BYTES: u64 = 25 * 1024 * 1024;

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

/// Fetch detailed metadata for a single remote file (size, perms, owner, group).
pub async fn stat(session: &SshSession, path: &str) -> AppResult<RemoteFileMeta> {
    let sftp = session.sftp().await?;
    let meta = sftp.metadata(path).await?;
    Ok(RemoteFileMeta {
        path: path.to_string(),
        size: meta.size.unwrap_or(0),
        permissions: meta.permissions.unwrap_or(0),
        owner: meta
            .user
            .clone()
            .filter(|u| !u.is_empty())
            .or_else(|| meta.uid.map(|u| u.to_string())),
        group: meta
            .group
            .clone()
            .filter(|g| !g.is_empty())
            .or_else(|| meta.gid.map(|g| g.to_string())),
        modified: meta.mtime.unwrap_or(0) as u64,
    })
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
///
/// Pass `offset` to resume a previously-interrupted download: the remote read
/// seeks to `offset` and the local file is opened in append mode (so the bytes
/// already on disk are preserved).
pub async fn download(
    app: &AppHandle,
    session: &SshSession,
    remote_path: &str,
    local_path: &str,
    transfer_id: &str,
    offset: Option<u64>,
) -> AppResult<()> {
    let sftp = session.sftp().await?;
    let total = sftp.metadata(remote_path).await?.size.unwrap_or(0);
    let file_name = remote_path.rsplit('/').next().unwrap_or(remote_path).to_string();

    let mut remote = sftp.open(remote_path).await?;
    if let Some(o) = offset {
        if o > 0 {
            remote.seek(SeekFrom::Start(o)).await?;
        }
    }
    let mut local = if offset.unwrap_or(0) > 0 {
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(local_path)
            .await?
    } else {
        tokio::fs::File::create(local_path).await?
    };

    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = offset.unwrap_or(0);
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
    remote.shutdown().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(())
}

/// Upload a local file into a remote directory.
///
/// Pass `offset` to resume a previously-interrupted upload: the local read and
/// the remote write both seek to `offset` (remote opened without TRUNCATE).
pub async fn upload(
    app: &AppHandle,
    session: &SshSession,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
    offset: Option<u64>,
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

    let o = offset.unwrap_or(0);
    if o > 0 {
        local.seek(SeekFrom::Start(o)).await?;
    }
    let flags = if o == 0 {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::WRITE
    };
    let mut remote = sftp.open_with_flags(remote_path.clone(), flags).await?;
    if o > 0 {
        remote.seek(SeekFrom::Start(o)).await?;
    }

    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = o;
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
    remote.shutdown().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(remote_path)
}

/// Read a remote text file's contents as a UTF-8 string for inline editing.
/// Rejects files that are too large (see `EDIT_MAX_BYTES`) or non-text so the UI
/// can fall back to a binary download instead of showing garbage.
pub async fn read_string(session: &SshSession, remote_path: &str) -> AppResult<String> {
    let sftp = session.sftp().await?;
    let size = sftp.metadata(remote_path).await?.size.unwrap_or(0);
    if size > EDIT_MAX_BYTES {
        return Err(AppError::Sftp(format!(
            "file is {size} bytes — too large to edit inline (limit {}). Download it instead.",
            EDIT_MAX_BYTES
        )));
    }

    let mut remote = sftp.open(remote_path).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut data = Vec::with_capacity(size.min(EDIT_MAX_BYTES) as usize);
    loop {
        let n = remote.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if data.len() + n > EDIT_MAX_BYTES as usize {
            remote.shutdown().await?;
            return Err(AppError::Sftp(
                "file is too large to edit inline. Download it instead.".into(),
            ));
        }
        data.extend_from_slice(&buf[..n]);
    }
    remote.shutdown().await?;
    String::from_utf8(data).map_err(|_| {
        AppError::Sftp("not a text file — binary or invalid UTF-8. Download it instead.".into())
    })
}

/// Overwrite a remote file with the given text content.
pub async fn write_string(
    session: &SshSession,
    remote_path: &str,
    content: &str,
) -> AppResult<()> {
    let sftp = session.sftp().await?;
    let mut remote = sftp
        .open_with_flags(
            remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await?;
    remote.write_all(content.as_bytes()).await?;
    remote.flush().await?;
    remote.shutdown().await?;
    Ok(())
}

/// Read a remote file's raw bytes as base64 for in-app preview (images, PDF,
/// video, audio). Capped by `PREVIEW_MAX_BYTES` so we never pull a huge file
/// through the IPC channel; the UI falls back to a download beyond that.
pub async fn read_bytes(session: &SshSession, remote_path: &str) -> AppResult<String> {
    let sftp = session.sftp().await?;
    let size = sftp.metadata(remote_path).await?.size.unwrap_or(0);
    if size > PREVIEW_MAX_BYTES {
        return Err(AppError::Sftp(format!(
            "file is {size} bytes — too large to preview inline (limit {}). Download it instead.",
            PREVIEW_MAX_BYTES
        )));
    }

    let mut remote = sftp.open(remote_path).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut data = Vec::with_capacity(size.min(PREVIEW_MAX_BYTES) as usize);
    loop {
        let n = remote.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if data.len() + n > PREVIEW_MAX_BYTES as usize {
            remote.shutdown().await?;
            return Err(AppError::Sftp(
                "file is too large to preview inline. Download it instead.".into(),
            ));
        }
        data.extend_from_slice(&buf[..n]);
    }
    remote.shutdown().await?;
    Ok(B64.encode(data))
}

/// Change a remote file's mode and/or ownership.
///
/// `permissions` is the numeric mode (e.g. `0o755`); `owner`/`group` may be a
/// name or a numeric uid/gid — names are resolved via `id -u` / `id -g` on the
/// remote host. Any field left `None` is left unchanged.
pub async fn set_perms(
    session: &SshSession,
    path: &str,
    permissions: Option<u32>,
    owner: Option<String>,
    group: Option<String>,
) -> AppResult<()> {
    let sftp = session.sftp().await?;
    let mut attrs = FileAttributes {
        permissions,
        ..Default::default()
    };
    if let Some(o) = owner {
        let o = o.trim().to_string();
        if !o.is_empty() {
            attrs.uid = Some(resolve_id(session, &o, "--user").await?);
        }
    }
    if let Some(g) = group {
        let g = g.trim().to_string();
        if !g.is_empty() {
            attrs.gid = Some(resolve_id(session, &g, "--group").await?);
        }
    }
    sftp.set_metadata(path, attrs).await?;
    Ok(())
}

/// Resolve a user/group name (or numeric id) to a numeric uid/gid via `id`.
async fn resolve_id(session: &SshSession, name: &str, flag: &str) -> AppResult<u32> {
    if let Ok(n) = name.parse::<u32>() {
        return Ok(n);
    }
    let out = session
        .exec(&format!("id {flag} {name} 2>/dev/null"))
        .await?;
    out.trim()
        .parse::<u32>()
        .map_err(|_| AppError::Sftp(format!("cannot resolve {flag} `{name}` to a numeric id")))
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
