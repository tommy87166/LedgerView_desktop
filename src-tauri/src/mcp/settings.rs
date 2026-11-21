use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri_plugin_clipboard_manager::ClipboardExt;

pub(super) const DEFAULT_PORT: u16 = 18476;

pub(crate) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE SCHEMA IF NOT EXISTS ledger_internal;
         CREATE TABLE IF NOT EXISTS ledger_internal.mcp_settings (
             id BOOLEAN PRIMARY KEY CHECK (id),
             port USMALLINT NOT NULL CHECK (port > 0),
             token VARCHAR
         )",
    )?;
    conn.execute(
        "INSERT INTO ledger_internal.mcp_settings (id, port) VALUES (true, ?)
         ON CONFLICT DO NOTHING",
        [DEFAULT_PORT],
    )?;
    // Older versions stored the random bearer secret in this column.
    // The prefix makes upgrades idempotent and distinguishes stored verifiers.
    conn.execute(
        "UPDATE ledger_internal.mcp_settings SET token='sha256:' || sha256(token)
         WHERE token IS NOT NULL AND NOT starts_with(token, 'sha256:')",
        [],
    )?;
    Ok(())
}

struct Settings {
    port: u16,
    token_hash: Option<String>,
}

impl Settings {
    fn read(conn: &Connection) -> Result<Self> {
        Ok(conn.query_row(
            "SELECT port, token FROM ledger_internal.mcp_settings WHERE id",
            [],
            |r| {
                Ok(Self {
                    port: r.get(0)?,
                    token_hash: r.get(1)?,
                })
            },
        )?)
    }

    fn info(&self, running: Option<&Running>, persistent: bool) -> Info {
        Info {
            port: self.port,
            url: running.map(|r| r.url.clone()),
            has_token: self.token_hash.is_some(),
            persistent,
            new_token: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    port: u16,
    url: Option<String>,
    has_token: bool,
    persistent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_token: Option<String>,
}

async fn with_db<T: Send + 'static>(
    engine: &Arc<Engine>,
    f: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
) -> Result<T> {
    let engine = engine.clone();
    tokio::task::spawn_blocking(move || {
        let conn = engine
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace unavailable"))?;
        f(&conn)
    })
    .await?
}

pub(super) fn token_hash(value: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(value))
}

fn generate_token(conn: &Connection) -> Result<String> {
    let token = Uuid::new_v4().simple().to_string();
    conn.execute(
        "UPDATE ledger_internal.mcp_settings SET token=? WHERE id",
        [token_hash(token.as_bytes())],
    )?;
    Ok(token)
}

impl Control {
    async fn info(&self, engine: &Arc<Engine>) -> Result<Info> {
        let running = self.0.lock().await;
        let settings = with_db(engine, Settings::read).await?;
        Ok(settings.info(running.as_ref(), engine.persistent))
    }

    async fn set_port(&self, engine: &Arc<Engine>, port: u16) -> Result<()> {
        let running = self.0.lock().await;
        ensure!(running.is_none(), "Turn off MCP before changing the port");
        ensure!(
            engine.persistent,
            "A disk workspace is required to save the port"
        );
        ensure!(port > 0, "Enter a port between 1 and 65535");
        with_db(engine, move |conn| {
            conn.execute(
                "UPDATE ledger_internal.mcp_settings SET port=? WHERE id",
                [port],
            )?;
            Ok(())
        })
        .await
    }

    async fn set_enabled(
        &self,
        engine: &Arc<Engine>,
        enabled: bool,
        cache_root: &Path,
        emit: Box<EventSink>,
    ) -> Result<Info> {
        let mut running = self.0.lock().await;
        if !enabled {
            stop(&mut running).await?;
        }
        let settings = with_db(engine, Settings::read).await?;
        if !enabled || running.is_some() {
            return Ok(settings.info(running.as_ref(), engine.persistent));
        }

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", settings.port))
            .await
            .with_context(|| format!("Opening MCP on 127.0.0.1:{}", settings.port))?;
        let address = listener.local_addr()?;
        let cache = cache::Cache::open(cache_root)?;
        let local = stdio::Listener::bind(cache_root).context("Opening local MCP endpoint")?;
        // Reveal a new token only after the listener and cache have opened.
        let mut info = settings.info(None, engine.persistent);
        let verifier = match settings.token_hash {
            Some(token) => token,
            None => {
                let token = with_db(engine, generate_token).await?;
                let verifier = token_hash(token.as_bytes());
                info.new_token = Some(token);
                info.has_token = true;
                verifier
            }
        };
        let core = Arc::new(Workspace {
            cache: Arc::new(cache),
            engine: engine.clone(),
            emit,
            files: Default::default(),
            query_slot: Arc::new(Semaphore::new(1)),
            edits: Default::default(),
            exports: Default::default(),
            stop: CancellationToken::new(),
        });
        let token = Arc::new(Mutex::new(verifier));
        let router = router(core.clone(), address.to_string(), token.clone());
        let stop = core.stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
        });
        let url = format!("http://{address}/mcp");
        info.url = Some(url.clone());
        let local_server = tokio::spawn(local.serve(core.clone()));
        *running = Some(Running {
            url,
            token_hash: token,
            core,
            server,
            local_server,
        });
        Ok(info)
    }

    async fn rotate(&self, engine: &Arc<Engine>) -> Result<String> {
        let running = self.0.lock().await;
        let token = with_db(engine, |conn| {
            ensure!(
                Settings::read(conn)?.token_hash.is_some(),
                "Enable MCP to create the first token"
            );
            generate_token(conn)
        })
        .await?;
        if let Some(r) = running.as_ref() {
            *r.token_hash.lock().unwrap() = token_hash(token.as_bytes());
        }
        Ok(token)
    }
}

#[tauri::command]
pub(crate) async fn mcp_info(
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<Info, String> {
    state
        .info(&database.engine()?)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_set_port(
    port: u16,
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<(), String> {
    state
        .set_port(&database.engine()?, port)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_set_enabled(
    enabled: bool,
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<Info, String> {
    let root = cache_root(&app).map_err(|e| e.to_string())?;
    let emit = Box::new(move |event: Value| {
        let show =
            event["type"] == "preview" || (event["type"] == "snapshot" && event["focus"] == true);
        app.emit_to("main", "mcp-workspace", event)?;
        if show {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Ok(())
    });
    state
        .set_enabled(&database.engine()?, enabled, &root, emit)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_regenerate_token(
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<String, String> {
    state
        .rotate(&database.engine()?)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_copy_connection(
    claude_stdio: Option<bool>,
    visible_token: Option<String>,
    app: AppHandle,
    state: State<'_, Control>,
) -> Result<(), String> {
    let running = state.0.lock().await;
    let r = running.as_ref().ok_or("MCP is disabled")?;
    let config = if claude_stdio.unwrap_or(false) {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        json!({"mcpServers":{"LedgerView":{"command":executable, "args":["--mcp-stdio"]}}})
    } else {
        let token = visible_token.as_deref().unwrap_or("<YOUR_TOKEN>");
        if visible_token.is_some()
            && !bool::from(
                token_hash(token.as_bytes())
                    .as_bytes()
                    .ct_eq(r.token_hash.lock().unwrap().as_bytes()),
            )
        {
            return Err("Token was replaced. Open settings again".into());
        }
        json!({"url":r.url, "headers":{"Authorization":format!("Bearer {token}")}})
    };
    app.clipboard()
        .write_text(serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn authenticate(url: &str, token: &str) -> Result<StatusCode> {
        let response = reqwest::Client::new().post(url).bearer_auth(token)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-11-25")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize",
                "params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}))
            .send().await?;
        Ok(response.status())
    }

    #[tokio::test]
    async fn port_and_token_survive_reopening_and_rotation_revokes_old_connections() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let work = dir.path().join("workspace");
        std::fs::create_dir(&work)?;
        // Upgrade an existing catalog created before MCP settings were stored.
        ledger::init(&Connection::open(work.join("ledger.duckdb"))?)?;
        let db = Arc::new(Engine::new(work.clone())?);
        let control = Control::default();
        let cache = dir.path().join("cache");
        let emit = || -> Box<EventSink> { Box::new(|_| Ok(())) };
        let initial = control.info(&db).await?;
        assert_eq!(initial.port, DEFAULT_PORT);
        assert!(initial.url.is_none() && !initial.has_token && initial.new_token.is_none());

        let occupied = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = occupied.local_addr()?.port();
        assert!(control.set_port(&db, 0).await.is_err());
        control.set_port(&db, port).await?;
        assert!(control
            .set_enabled(&db, true, &cache, emit())
            .await
            .is_err());
        assert!(!control.info(&db).await?.has_token);
        drop(occupied);

        let started = control.set_enabled(&db, true, &cache, emit()).await?;
        let url = started.url.unwrap();
        assert_eq!(url, format!("http://127.0.0.1:{port}/mcp"));
        let original = started.new_token.unwrap();
        assert_eq!(authenticate(&url, &original).await?, StatusCode::OK);
        let stored = with_db(&db, |conn| Ok(Settings::read(conn)?.token_hash.unwrap())).await?;
        assert_eq!(stored, token_hash(original.as_bytes()));
        assert_eq!(authenticate(&url, &stored).await?, StatusCode::UNAUTHORIZED);
        let status = serde_json::to_string(&control.info(&db).await?)?;
        assert!(!status.contains(&original));
        assert!(control.set_port(&db, DEFAULT_PORT).await.is_err());
        assert!(control
            .set_enabled(&db, true, &cache, emit())
            .await?
            .new_token
            .is_none());
        let disabled = control.set_enabled(&db, false, &cache, emit()).await?;
        assert!(disabled.url.is_none() && disabled.has_token && disabled.new_token.is_none());
        drop(db);

        let db = Arc::new(Engine::new(work.clone())?);
        let restarted = control.set_enabled(&db, true, &cache, emit()).await?;
        assert_eq!(restarted.port, port);
        assert!(restarted.new_token.is_none());
        assert_eq!(authenticate(&url, &original).await?, StatusCode::OK);
        let rotated = control.rotate(&db).await?;
        assert_eq!(
            authenticate(&url, &original).await?,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(authenticate(&url, &rotated).await?, StatusCode::OK);
        control.shutdown().await?;
        drop(db);

        let db = Arc::new(Engine::new(work)?);
        control.set_enabled(&db, true, &cache, emit()).await?;
        assert_eq!(authenticate(&url, &rotated).await?, StatusCode::OK);
        control.shutdown().await?;
        let offline = control.rotate(&db).await?;
        control.set_enabled(&db, true, &cache, emit()).await?;
        assert_eq!(
            authenticate(&url, &rotated).await?,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(authenticate(&url, &offline).await?, StatusCode::OK);
        control.shutdown().await?;
        control.set_port(&db, DEFAULT_PORT).await?;
        assert_eq!(control.info(&db).await?.port, DEFAULT_PORT);
        Ok(())
    }

    #[test]
    fn upgrades_plaintext_once_and_keeps_the_existing_http_credential() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        init(&conn)?;
        let original = Uuid::new_v4().simple().to_string();
        conn.execute(
            "UPDATE ledger_internal.mcp_settings SET token=?",
            [&original],
        )?;
        for _ in 0..2 {
            init(&conn)?;
            assert_eq!(
                Settings::read(&conn)?.token_hash,
                Some(token_hash(original.as_bytes()))
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn memory_workspace_uses_the_default_port_and_keeps_no_disk_credentials() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let file = dir.path().join("file");
        std::fs::write(&file, b"fixture")?;
        let work = file.join("workspace");
        let control = Control::default();
        let db = Arc::new(Engine::new(work.clone())?);
        let info = control.info(&db).await?;
        assert!(!info.persistent);
        assert_eq!(info.port, DEFAULT_PORT);
        assert!(control.set_port(&db, 43210).await.is_err());
        with_db(&db, generate_token).await?;
        assert!(control.info(&db).await?.has_token);
        drop(db);
        assert!(!control.info(&Arc::new(Engine::new(work)?)).await?.has_token);
        Ok(())
    }
}
