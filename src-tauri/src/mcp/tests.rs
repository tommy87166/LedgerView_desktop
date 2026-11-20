use super::*;
use reqwest::Client;
use std::path::Path;
use tempfile::TempDir;

struct Server {
    url: String,
    control: Control,
    client: Client,
    core: Arc<Workspace>,
    events: Arc<Mutex<Vec<Value>>>,
    _dir: TempDir,
}

impl Server {
    async fn new() -> Result<Self> {
        let dir = tempfile::tempdir()?;
        let engine = Arc::new(Engine::new(dir.path().join("work"))?);
        let events = Arc::new(Mutex::new(Vec::new()));
        let out = events.clone();
        let core = Arc::new(Workspace {
            cache: Arc::new(cache::Cache::open(&dir.path().join("cache"))?),
            engine,
            emit: Box::new(move |e| {
                out.lock().unwrap().push(e);
                Ok(())
            }),
            files: Default::default(),
            query_slot: Arc::new(Semaphore::new(1)),
            edits: Default::default(),
            stop: CancellationToken::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let host = listener.local_addr()?.to_string();
        let token = Arc::new(Mutex::new("test-token".to_owned()));
        let router = router(core.clone(), host.clone(), token.clone());
        let stop = core.stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
        });
        let url = format!("http://{host}/mcp");
        let running = Running {
            url: url.clone(),
            token,
            core: core.clone(),
            server,
        };
        Ok(Self {
            url,
            control: Control(tokio::sync::Mutex::new(Some(running))),
            client: Client::new(),
            core,
            events,
            _dir: dir,
        })
    }
    fn post(&self, method: &str, params: Value) -> reqwest::RequestBuilder {
        self.client
            .post(&self.url)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-11-25")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let resp = self
            .post(method, params)
            .bearer_auth("test-token")
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        ensure!(status.is_success(), "{status}: {text}");
        let v: Value = serde_json::from_str(&text)?;
        ensure!(v["error"].is_null(), "{v}");
        Ok(v["result"].clone())
    }
    async fn call(&self, name: &str, args: Value) -> Result<Value> {
        let r = self
            .rpc("tools/call", json!({"name":name,"arguments":args}))
            .await?;
        ensure!(r["isError"] != true, "{}", r["content"]);
        Ok(r["structuredContent"].clone())
    }
    fn file(&self, name: &str) -> Result<String> {
        let path = self._dir.path().join(name);
        let ds = self.core.db(|conn| {
            conn.execute_batch(&format!(
                "COPY (SELECT range AS n FROM range(125)) TO {} (FORMAT PARQUET)",
                ledger::literal(path.to_str().unwrap())
            ))?;
            ledger::open(conn, &path)
        })?;
        Ok(ds.id)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.core.stop.cancel();
    }
}

#[tokio::test]
async fn http_handshake_lists_tools_and_validates_bearer_host_and_origin() -> Result<()> {
    let s = Server::new().await?;
    let init = json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}});
    let no_auth = s.post("initialize", init.clone()).send().await?;
    assert_eq!(no_auth.status(), 401);
    for header in [
        ("Host", "example.invalid"),
        ("Origin", "https://example.invalid"),
    ] {
        assert_eq!(
            s.post("initialize", init.clone())
                .bearer_auth("test-token")
                .header(header.0, header.1)
                .send()
                .await?
                .status(),
            403
        );
    }
    let response = s.rpc("initialize", init).await?;
    assert_eq!(response["serverInfo"]["name"], "LedgerView");
    let list = s.rpc("tools/list", json!({})).await?;
    for name in [
        "list_sources",
        "query",
        "result_page",
        "save_snapshot",
        "list_notebooks",
        "edit_notebook",
    ] {
        assert!(list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == name));
    }
    Ok(())
}

#[tokio::test]
async fn queries_preview_page_and_replace_only_ai_snapshots() -> Result<()> {
    let s = Server::new().await?;
    let id = s.file("sample.parquet")?;
    let sources = s.call("list_sources", json!({})).await?;
    assert_eq!(sources["sources"][0]["name"], "sample");
    let ask = |sql: &str, preview| s.call("query", json!({"sql":sql,"preview":preview}));
    let first = ask("FROM sample SELECT n ORDER BY n", false).await?;
    assert_eq!(first["rows"][0], json!(["0"]));
    assert_eq!(first["next"], 100);
    let page = s
        .call(
            "result_page",
            json!({"resultId":first["resultId"],"start":100}),
        )
        .await?;
    assert_eq!(page["rows"][24], json!(["124"]));
    let original = s
        .call(
            "save_snapshot",
            json!({"resultId":first["resultId"],"name":"AI sample","focus":true}),
        )
        .await?;
    let second = ask("SELECT max(n) AS maximum FROM sample", true).await?;
    assert_eq!(second["total"], 1);
    assert!(second.get("rows").is_none());
    let replaced=s.call("save_snapshot",json!({"resultId":second["resultId"],"name":"AI sample","replaceId":original["id"],"focus":true})).await?;
    assert_eq!(original["id"], replaced["id"]);
    let check = ask("SELECT * FROM \"AI sample\"", false).await?;
    assert_eq!(check["rows"], json!([["124"]]));
    let manual = s.core.db(|c| {
        ledger::create_snapshot(
            c,
            &ledger::dataset(c, &id)?,
            Default::default(),
            vec![],
            vec!["n".into()],
            "manual".into(),
        )
    })?;
    let refused = s
        .call(
            "save_snapshot",
            json!({"resultId":second["resultId"],"name":"manual","replaceId":manual.id}),
        )
        .await;
    assert!(refused.unwrap_err().to_string().contains("Only AI-created"));
    assert_eq!(
        s.core.db(|c| ledger::dataset(c, &manual.id))?.row_count,
        125
    );
    let events = s.events.lock().unwrap();
    assert!(events
        .iter()
        .any(|e| e["type"] == "preview" && e["resultId"] == second["resultId"]));
    assert!(events.iter().any(|e| e["type"] == "snapshot"
        && e["focus"] == true
        && e["snapshot"]["aiCreated"] == true));
    Ok(())
}

#[tokio::test]
async fn preview_button_saves_all_rows_and_mcp_can_replace_the_same_snapshot() -> Result<()> {
    let s = Server::new().await?;
    let preview = s
        .call(
            "query",
            json!({"sql":"SELECT i FROM range(236) AS r(i)", "preview":true}),
        )
        .await?;
    let snapshot = s
        .control
        .snapshot_preview(preview["resultId"].as_str().unwrap().into())
        .await?;
    assert_eq!(snapshot["total"], 236);
    assert!(s
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event["type"] == "snapshot"
            && event["snapshot"]["id"] == snapshot["id"]
            && event["snapshot"]["aiCreated"] == true
            && event["focus"] == false));
    let replacement = s
        .call("query", json!({"sql":"SELECT 42 AS answer"}))
        .await?;
    let updated = s
        .call(
            "save_snapshot",
            json!({
                "resultId":replacement["resultId"],"name":"Revised","replaceId":snapshot["id"]
            }),
        )
        .await?;
    assert_eq!(updated["id"], snapshot["id"]);
    assert_eq!(updated["total"], 1);
    let sources = s.call("list_sources", json!({})).await?;
    let source = sources["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["id"] == snapshot["id"])
        .unwrap();
    let sql = format!(
        "SELECT answer FROM {}",
        ledger::ident(source["name"].as_str().unwrap())
    );
    let rows = s.call("query", json!({"sql":sql})).await?;
    assert_eq!(rows["rows"], json!([["42"]]));
    Ok(())
}

#[tokio::test]
async fn shutdown_removes_results_and_snapshot_copies_and_preserves_workspace() -> Result<()> {
    let s = Server::new().await?;
    s.file("source.parquet")?;
    let result = s
        .call("query", json!({"sql":"SELECT n FROM source"}))
        .await?;
    let file = s.core.result(result["resultId"].as_str().unwrap())?;
    let snap = s
        .call(
            "save_snapshot",
            json!({"resultId":result["resultId"],"name":"saved"}),
        )
        .await?;
    let view = s
        .call("query", json!({"sql":"SELECT count(*) FROM saved"}))
        .await?;
    assert_eq!(view["rows"], json!([["125"]]));
    let cache = &s.core.cache.directory;
    assert!(
        dunce::canonicalize(&file.dataset.source_file)?.starts_with(dunce::canonicalize(cache)?)
    );
    assert!(Path::new(&file.dataset.source_file).is_file());
    let children = std::fs::read_dir(cache)?.collect::<std::io::Result<Vec<_>>>()?;
    assert!(children
        .iter()
        .any(|d| d.path().join("snapshot.parquet").is_file()));

    s.control.shutdown().await?;
    assert!(!cache.exists());
    assert!(query::page(&file, 0).is_err());
    assert!(s._dir.path().join("source.parquet").is_file());
    let conn = s.core.engine.conn.lock().unwrap();
    assert_eq!(
        ledger::dataset(&conn, snap["id"].as_str().unwrap())?.row_count,
        125
    );
    Ok(())
}

#[tokio::test]
async fn queries_cannot_read_unregistered_files_or_mutate_workspace() -> Result<()> {
    let s = Server::new().await?;
    s.file("source.parquet")?;
    let private = s._dir.path().join("outside.parquet");
    std::fs::copy(s._dir.path().join("source.parquet"), &private)?;
    let text = ledger::literal(Path::new(&private).to_str().unwrap());
    for sql in [
        format!("SELECT * FROM read_parquet({text})"),
        "DROP TABLE source".into(),
    ] {
        assert!(s.call("query", json!({"sql":sql})).await.is_err());
    }
    assert_eq!(
        s.call("query", json!({"sql":"SELECT count(*) FROM source"}))
            .await?["rows"],
        json!([["125"]])
    );
    Ok(())
}

#[tokio::test]
async fn notebook_edits_require_current_revision_and_desktop_acknowledgement() -> Result<()> {
    let s = Server::new().await?;
    let book = s.core.db(|c| notebooks::create(c, "Query".into()))?;
    let listed = s.call("list_notebooks", json!({})).await?;
    let base = &listed["notebooks"][0];
    let mut args = json!({"id":base["id"],"expectedRevision":"outdated","name":"Review","cells":[{"slot":0,"name":"Total","sql":"SELECT 1"}]});
    assert!(s
        .call("edit_notebook", args.clone())
        .await
        .unwrap_err()
        .to_string()
        .contains("latest revision"));
    args["expectedRevision"] = base["revision"].clone();
    let respond = async {
        loop {
            let event = s
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["type"] == "edit")
                .cloned();
            if let Some(e) = event {
                assert_eq!(e["before"], serde_json::to_value(&book)?);
                assert_eq!(e["cells"], args["cells"]);
                let send = s
                    .core
                    .edits
                    .lock()
                    .unwrap()
                    .remove(e["ticket"].as_str().unwrap())
                    .unwrap();
                send.reply
                    .send(Err("Notebook changed in LedgerView".into()))
                    .unwrap();
                return Ok::<(), anyhow::Error>(());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    let (result, ack) = tokio::join!(
        s.call("edit_notebook", args.clone()),
        tokio::time::timeout(Duration::from_secs(3), respond)
    );
    ack??;
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Notebook changed in LedgerView"));
    Ok(())
}

#[tokio::test]
async fn quoted_source_names_read_only_the_registered_file() -> Result<()> {
    let s = Server::new().await?;
    s.file("[entry]'範例.parquet")?;
    let result = s
        .call(
            "query",
            json!({"sql":"SELECT max(n) FROM \"[entry]'範例\""}),
        )
        .await?;
    assert_eq!(result["rows"], json!([["124"]]));
    Ok(())
}
