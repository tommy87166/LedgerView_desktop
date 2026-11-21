// The bridge only forwards MCP frames. DuckDB and every tool handler live in
// the desktop process and are shared with HTTP clients.
use super::{Tools, Workspace};
use anyhow::{ensure, Context, Result};
use futures_util::StreamExt;
use mcpmesh_local_api::transport::{
    authorize_local_peer, bind_local, connect_local, split_local, LocalListener,
};
use rmcp::{model::RequestId, ServiceExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinSet;
use tokio_util::codec::{FramedRead, LinesCodec};
use uuid::Uuid;

const IDENTITY: &str = "session/stdio.id";

#[derive(Serialize, Deserialize)]
struct Endpoint {
    path: PathBuf,
    identity: Uuid,
}

#[cfg(unix)]
fn socket_address(root: &Path) -> Result<(PathBuf, Option<tempfile::TempDir>)> {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    };
    let session = dunce::canonicalize(root.join("session"))?.join("stdio.sock");
    if session.as_os_str().as_bytes().len() < 104 {
        return Ok((session, None));
    }
    // Keep the socket path short on systems with long home or cache paths.
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| {
            dir.is_absolute()
                && dir.as_os_str().as_bytes().len() < 65
                && dir.symlink_metadata().is_ok_and(|m| {
                    m.is_dir()
                        && m.mode() & 0o077 == 0
                        && m.uid() == rustix::process::geteuid().as_raw()
                })
        })
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let private = tempfile::Builder::new()
        .prefix("lv-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(runtime)?;
    Ok((private.path().join("stdio.sock"), Some(private)))
}

pub(super) struct Listener {
    inner: LocalListener,
    endpoint: Endpoint,
    #[cfg(unix)]
    _socket_directory: Option<tempfile::TempDir>,
}

impl Listener {
    // The caller holds the workspace cache's exclusive owner lock. It also
    // owns the private session directory where we publish the server identity.
    pub(super) fn bind(root: &Path) -> Result<Self> {
        #[cfg(unix)]
        let (path, directory) = socket_address(root)?;
        #[cfg(windows)]
        let path = PathBuf::from(format!(r"\\.\pipe\LedgerView-{}", Uuid::new_v4()));
        let listener = Self {
            inner: bind_local(&path)?,
            endpoint: Endpoint {
                path,
                identity: Uuid::new_v4(),
            },
            #[cfg(unix)]
            _socket_directory: directory,
        };
        let dest = root.join(IDENTITY);
        let mut file = tempfile::NamedTempFile::new_in(dest.parent().unwrap())?;
        serde_json::to_writer(&mut file, &listener.endpoint)?;
        file.flush()?;
        file.persist(dest)?;
        Ok(listener)
    }

    pub(super) async fn serve(mut self, workspace: Arc<Workspace>) {
        let mut sessions = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = workspace.stop.cancelled() => break,
                Some(_) = sessions.join_next(), if !sessions.is_empty() => (),
                incoming = self.inner.accept() => match incoming {
                    Ok(mut stream) if authorize_local_peer(&stream) => {
                        let tools = Tools(workspace.clone());
                        let stop = workspace.stop.child_token();
                        let identity = self.endpoint.identity;
                        sessions.spawn(async move {
                            // Authenticate the listener to the bridge before it sends any SQL.
                            stream.write_all(identity.as_bytes()).await?;
                            let service = tools.serve_with_ct(split_local(stream), stop).await?;
                            service.waiting().await?;
                            anyhow::Ok(())
                        });
                    }
                    Ok(_) => (),
                    Err(error) => {
                        eprintln!("LedgerView MCP local connection: {error}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        }
        sessions.shutdown().await;
    }
}

#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.endpoint.path);
    }
}

pub(crate) fn run() -> Result<()> {
    let root = std::env::var_os("LEDGERVIEW_MCP_CACHE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            dirs::cache_dir().map(|dir| dir.join(super::APP_IDENTIFIER).join(super::CACHE_NAME))
        })
        .context("Unable to locate the LedgerView cache")?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async { bridge(&root, rmcp::transport::io::stdio()).await });
    // A Tokio stdin read can still be blocked when the desktop closes first.
    runtime.shutdown_background();
    result
}

pub(super) async fn bridge(
    root: &Path,
    (input, mut output): (impl AsyncRead + Unpin, impl AsyncWrite + Unpin),
) -> Result<()> {
    let connect = async {
        let expected: Endpoint = serde_json::from_slice(&std::fs::read(root.join(IDENTITY))?)?;
        #[cfg(windows)]
        ensure!(
            expected
                .path
                .to_str()
                .and_then(|s| s.strip_prefix(r"\\.\pipe\LedgerView-"))
                .is_some_and(|suffix| Uuid::parse_str(suffix).is_ok()),
            "Unexpected local pipe"
        );
        let mut stream = connect_local(&expected.path).await?;
        #[cfg(unix)]
        ensure!(authorize_local_peer(&stream), "Unexpected desktop user");
        let mut id = [0; 16];
        stream.read_exact(&mut id).await?;
        ensure!(
            expected.identity.as_bytes() == &id,
            "Unexpected desktop instance"
        );
        anyhow::Ok(stream)
    };
    let stream = tokio::time::timeout(Duration::from_secs(3), connect)
        .await
        .context("Timed out connecting to LedgerView")?
        .context("Open LedgerView and enable MCP before connecting with stdio")?;
    let (reader, mut writer) = split_local(stream);
    let codec =
        || LinesCodec::new_with_max_length(rmcp::transport::async_rw::DEFAULT_MAX_LINE_LENGTH);
    let mut incoming = FramedRead::new(input, codec());
    let mut replies = FramedRead::new(reader, codec());
    let mut outstanding = HashSet::new();
    let mut eof = false;

    #[derive(Deserialize)]
    struct Envelope {
        id: Option<RequestId>,
        method: Option<String>,
    }
    #[derive(Deserialize)]
    struct Cancel {
        params: rmcp::model::CancelledNotificationParam,
    }

    while !eof || !outstanding.is_empty() {
        tokio::select! {
            message = incoming.next(), if !eof => {
                let Some(line) = message.transpose()? else { eof = true; continue; };
                if let Ok(frame) = serde_json::from_str::<Envelope>(&line) {
                    if let (Some(_), Some(id)) = (&frame.method, frame.id) { outstanding.insert(id); }
                    if frame.method.as_deref() == Some("notifications/cancelled") {
                        if let Some(id) = serde_json::from_str::<Cancel>(&line).ok().and_then(|c| c.params.request_id) {
                            outstanding.remove(&id);
                        }
                    }
                }
                writer.write_all(line.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.flush().await?;
            }
            message = replies.next() => {
                let Some(line) = message.transpose()? else { break; };
                if let Ok(Envelope { method: None, id: Some(id) }) = serde_json::from_str(&line) {
                    outstanding.remove(&id);
                }
                output.write_all(line.as_bytes()).await?;
                output.write_all(b"\n").await?;
                output.flush().await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn long_workspace_paths_get_private_endpoints_and_fresh_server_identities() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let workspace = root.path().join("workspace".repeat(11));
        let cache = super::super::cache::Cache::open(&workspace)?;
        let read = || -> Result<Endpoint> {
            Ok(serde_json::from_slice(&std::fs::read(
                workspace.join(IDENTITY),
            )?)?)
        };
        let first = Listener::bind(&workspace)?;
        let before = read()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                before
                    .path
                    .parent()
                    .unwrap()
                    .metadata()?
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(before.path.metadata()?.permissions().mode() & 0o777, 0o600);
        }
        drop(first);
        let second = Listener::bind(&workspace)?;
        let after = read()?;
        assert_ne!(before.path, after.path);
        assert_ne!(before.identity, after.identity);
        drop(second);
        cache.close()?;
        Ok(())
    }
}
