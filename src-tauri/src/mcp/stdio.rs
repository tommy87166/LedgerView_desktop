// The bridge only forwards MCP frames. DuckDB and every tool handler live in
// the desktop process and are shared with HTTP clients.
use super::{Tools, Workspace};
use anyhow::{ensure, Context, Result};
use mcpmesh_local_api::transport::{
    authorize_local_peer, bind_local, connect_local, split_local, LocalListener,
};
use rmcp::ServiceExt;
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinSet;
use uuid::Uuid;

const IDENTITY: &str = "session/stdio.id";

fn address(root: &Path) -> Result<PathBuf> {
    let mut hash = DefaultHasher::new();
    dunce::canonicalize(root)?.hash(&mut hash);
    let key = hash.finish();
    #[cfg(windows)]
    return Ok(format!(r"\\.\pipe\LedgerView-{key:016x}").into());
    // A long home directory can exceed the kernel's Unix socket path limit.
    #[cfg(unix)]
    Ok(PathBuf::from("/tmp")
        .join(format!(
            "ledgerview-{}",
            rustix::process::geteuid().as_raw()
        ))
        .join(format!("{key:016x}.sock")))
}

pub(super) struct Listener {
    inner: LocalListener,
    identity: Uuid,
    #[cfg(unix)]
    path: PathBuf,
}

impl Listener {
    // The caller holds the workspace cache's exclusive owner lock. It also
    // owns the private session directory where we publish the server identity.
    pub(super) fn bind(root: &Path) -> Result<Self> {
        let path = address(root)?;
        let inner = bind_local(&path)?;
        let listener = Self {
            inner,
            identity: Uuid::new_v4(),
            #[cfg(unix)]
            path,
        };
        let dest = root.join(IDENTITY);
        let mut file = tempfile::NamedTempFile::new_in(dest.parent().unwrap())?;
        file.write_all(listener.identity.as_bytes())?;
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
                        let identity = self.identity;
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
        let _ = std::fs::remove_file(&self.path);
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
    (mut input, mut output): (impl AsyncRead + Unpin, impl AsyncWrite + Unpin),
) -> Result<()> {
    let connect = async {
        let expected = Uuid::from_slice(&std::fs::read(root.join(IDENTITY))?)?;
        let mut stream = connect_local(&address(root)?).await?;
        #[cfg(unix)]
        ensure!(authorize_local_peer(&stream), "Unexpected desktop user");
        let mut id = [0; 16];
        stream.read_exact(&mut id).await?;
        ensure!(expected.as_bytes() == &id, "Unexpected desktop instance");
        anyhow::Ok(stream)
    };
    let stream = tokio::time::timeout(Duration::from_secs(3), connect)
        .await
        .context("Timed out connecting to LedgerView")?
        .context("Open LedgerView and enable MCP before connecting with stdio")?;
    let (mut reader, mut writer) = split_local(stream);
    // EOF on either side ends this stdio session, including on Windows pipes
    // where a write-half shutdown alone cannot notify the other process.
    tokio::select! {
        result = tokio::io::copy(&mut input, &mut writer) => { result?; }
        result = tokio::io::copy(&mut reader, &mut output) => { result?; }
    }
    output.flush().await?;
    Ok(())
}
