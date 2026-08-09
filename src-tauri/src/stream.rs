//! Bridges the gap between "the session is already producing output" and
//! "the webview is actually listening".
//!
//! Every transport here starts emitting the moment its reader thread/task is
//! spawned, but the UI can only call `listen()` after the command returns, React
//! re-renders, and an async IPC round-trip completes. That window is tens of
//! milliseconds — and for SSH it is far worse, because `connect()` additionally
//! opens the SFTP subsystem before handing back the session id.
//!
//! Anything emitted into that window has no listener and is lost forever. In
//! practice that means the shell banner and the *first prompt* vanish, so the
//! terminal looks completely dead until the user blindly presses Enter.
//!
//! The fix is an explicit handshake: output is buffered until the UI calls
//! `*_attach`, which atomically flushes the backlog and switches to live
//! emission. No byte is dropped, none is delivered twice.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;

use crate::types::SessionClosed;

/// Cap on buffered pre-attach output. A board spewing boot logs can produce a
/// lot before the UI is ready; we keep the *tail* because that is where the
/// prompt — the part the user needs — ends up.
const MAX_BACKLOG: usize = 256 * 1024;

#[derive(Default)]
struct Inner {
    attached: bool,
    backlog: Vec<u8>,
    closed: Option<SessionClosed>,
}

#[derive(Default)]
pub struct OutputBuffer {
    inner: Mutex<Inner>,
}

/// Everything that happened before the UI managed to attach.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    /// Base64 of the buffered bytes, to be written before any live chunk.
    pub backlog: String,
    /// Set when the session already died pre-attach, so the UI still learns.
    pub closed: Option<SessionClosed>,
}

impl OutputBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` when the caller should emit these bytes itself, `false`
    /// when they were buffered for a pending attach.
    ///
    /// The caller emits *after* releasing the lock. That is safe because each
    /// session has exactly one producer, so ordering is preserved.
    pub fn accept(&self, bytes: &[u8]) -> bool {
        let mut inner = self.inner.lock();
        if inner.attached {
            return true;
        }
        inner.backlog.extend_from_slice(bytes);
        let overflow = inner.backlog.len().saturating_sub(MAX_BACKLOG);
        if overflow > 0 {
            inner.backlog.drain(..overflow);
        }
        false
    }

    /// Same contract as [`accept`], for the terminating signal.
    pub fn accept_closed(&self, info: &SessionClosed) -> bool {
        let mut inner = self.inner.lock();
        if inner.attached {
            return true;
        }
        inner.closed = Some(info.clone());
        false
    }

    /// Flush everything buffered and switch to live emission.
    ///
    /// Idempotent: a second call (e.g. a remounted terminal) simply returns an
    /// empty backlog rather than replaying stale output.
    pub fn attach(&self) -> Attached {
        let mut inner = self.inner.lock();
        inner.attached = true;
        Attached {
            backlog: B64.encode(std::mem::take(&mut inner.backlog)),
            closed: inner.closed.take(),
        }
    }
}
