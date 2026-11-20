use super::*;
use std::path::Path;
use tauri_plugin_clipboard_manager::ClipboardExt;

const DEFAULT_PORT: u16 = 18476;

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
    Ok(())
}

struct Settings {
    port: u16,
    token: Option<String>,
}

impl Settings {
    fn read(conn: &Connection) -> Result<Self> {
        Ok(conn.query_row(
            "SELECT port, token FROM ledger_internal.mcp_settings WHERE id",
            [],
            |r| {
                Ok(Self {
                    port: r.get(0)?,
                    token: r.get(1)?,
                })
            },
        )?)
    }

    fn info(&self, running: Option<&Running>, persistent: bool) -> Info {
        Info {
            port: self.port,
            url: running.map(|r| r.url.clone()),
            has_token: self.token.is_some(),
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

fn generate_token(conn: &Connection) -> Result<String> {
    let token = Uuid::new_v4().simple().to_string();
    conn.execute(
        "UPDATE ledger_internal.mcp_settings SET token=? WHERE id",
        [&token],
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
        // Reveal a new token only after the listener and cache have opened.
        let mut info = settings.info(None, engine.persistent);
        let token = match settings.token {
            Some(token) => token,
            None => {
                let token = with_db(engine, generate_token).await?;
                info.new_token = Some(token.clone());
                info.has_token = true;
                token
            }
        };
        let core = Arc::new(Workspace {
            cache: Arc::new(cache),
            engine: engine.clone(),
            emit,
            files: Default::default(),
            query_slot: Arc::new(Semaphore::new(1)),
            edits: Default::default(),
            stop: CancellationToken::new(),
        });
        let token = Arc::new(Mutex::new(token));
        let router = router(core.clone(), address.to_string(), token.clone());
        let stop = core.stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
        });
        let url = format!("http://{address}/mcp");
        info.url = Some(url.clone());
        *running = Some(Running {
            url,
            token,
            core,
            server,
        });
        Ok(info)
    }

    async fn rotate(&self, engine: &Arc<Engine>) -> Result<String> {
        let running = self.0.lock().await;
        let token = with_db(engine, |conn| {
            ensure!(
                Settings::read(conn)?.token.is_some(),
                "Enable MCP to create the first token"
            );
            generate_token(conn)
        })
        .await?;
        if let Some(r) = running.as_ref() {
            r.token.lock().unwrap().clone_from(&token);
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
        .info(&database.0.clone()?)
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
        .set_port(&database.0.clone()?, port)
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
        .set_enabled(&database.0.clone()?, enabled, &root, emit)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_regenerate_token(
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<String, String> {
    state
        .rotate(&database.0.clone()?)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub(crate) async fn mcp_copy_connection(
    app: AppHandle,
    state: State<'_, Control>,
) -> Result<(), String> {
    let running = state.0.lock().await;
    let r = running.as_ref().ok_or("MCP is disabled")?;
    let token = r.token.lock().unwrap();
    let config = json!({"url":r.url, "headers":{"Authorization":format!("Bearer {token}")}});
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
