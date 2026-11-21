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
            exports: Default::default(),
            stop: CancellationToken::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let host = listener.local_addr()?.to_string();
        let token = Arc::new(Mutex::new(settings::token_hash(b"test-token")));
        let router = router(core.clone(), host.clone(), token.clone());
        let stop = core.stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await
        });
        let url = format!("http://{host}/mcp");
        let local = stdio::Listener::bind(&dir.path().join("cache"))?;
        let local_server = tokio::spawn(local.serve(core.clone()));
        let running = Running {
            url: url.clone(),
            token_hash: token,
            core: core.clone(),
            server,
            local_server,
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
        "export_excel",
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

#[tokio::test]
async fn stdio_client_lists_desktop_tools_and_queries_the_same_workspace() -> Result<()> {
    let s = Server::new().await?;
    s.file("sample.parquet")?;
    let cache_root = s._dir.path().join("cache");
    // CI also checks the released GUI executable inherits the client's pipes.
    if let Some(executable) = std::env::var_os("LEDGERVIEW_TEST_STDIO_BIN") {
        use std::process::Stdio;
        let mut child = tokio::process::Command::new(executable)
            .arg("--mcp-stdio")
            .env_remove("LEDGERVIEW_MCP_TOKEN")
            .env_remove("LEDGERVIEW_MCP_PORT")
            .env("LEDGERVIEW_MCP_CACHE_DIR", &cache_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        exercise_stdio(child.stdout.take().unwrap(), child.stdin.take().unwrap()).await?;
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await??;
        ensure!(status.success(), "stdio process exited with {status}");
        return Ok(());
    }
    let (client, bridge) = tokio::io::duplex(65536);
    let run =
        tokio::spawn(async move { stdio::bridge(&cache_root, tokio::io::split(bridge)).await });
    let (input, output) = tokio::io::split(client);
    exercise_stdio(input, output).await?;
    tokio::time::timeout(Duration::from_secs(10), run).await???;
    Ok(())
}

async fn exercise_stdio(
    input: impl tokio::io::AsyncRead + Unpin,
    mut output: impl tokio::io::AsyncWrite + Unpin,
) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut lines = BufReader::new(input).lines();
    for (id, method, params) in [
        (
            1,
            "initialize",
            json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stdio-test","version":"1"}}),
        ),
        (2, "tools/list", json!({})),
        (
            3,
            "tools/call",
            json!({"name":"query","arguments":{"sql":"SELECT count(*) AS n FROM sample"}}),
        ),
    ] {
        let frame =
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string() + "\n";
        output.write_all(frame.as_bytes()).await?;
        if id == 3 {
            output.shutdown().await?;
        }
        let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await??
            .context("No stdio response")?;
        let reply: Value = serde_json::from_str(&line)?;
        assert_eq!(reply["id"], id);
        ensure!(reply["error"].is_null(), "{reply}");
        match id {
            1 => {
                assert_eq!(reply["result"]["serverInfo"]["name"], "LedgerView");
                output
                    .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
                    .await?;
            }
            2 => {
                let tools = reply["result"]["tools"].as_array().unwrap();
                for name in ["edit_notebook", "export_excel"] {
                    assert!(tools.iter().any(|tool| tool["name"] == name));
                }
            }
            _ => assert_eq!(
                reply["result"]["structuredContent"]["rows"],
                json!([["125"]])
            ),
        }
    }
    Ok(())
}

#[tokio::test]
async fn excel_tool_exports_full_results_and_snapshots_only_inside_workspace() -> Result<()> {
    use calamine::{open_workbook, Data, Reader, Xlsx};
    let s = Server::new().await?;
    let source_id = s.file("sample.parquet")?;
    let result = s
        .call(
            "query",
            json!({"sql":"SELECT n FROM sample ORDER BY n DESC"}),
        )
        .await?;
    let id = &result["resultId"];
    let snap = s
        .call("save_snapshot", json!({"resultId":id,"name":"Example"}))
        .await?;
    for (input, name) in [
        (
            json!({"snapshotId":snap["id"],"fileName":"摘要.XLSX"}),
            "摘要.XLSX".to_owned(),
        ),
        (
            json!({"resultId":id}),
            format!("{}.xlsx", id.as_str().unwrap()),
        ),
    ] {
        let exported = s.call("export_excel", input.clone()).await?;
        let expected = s.core.engine.directory.join(&name);
        assert_eq!(exported["path"], json!(expected));
        assert_eq!(exported["total"], 125);
        let mut book: Xlsx<_> = open_workbook(&expected)?;
        let sheet = book.worksheet_range_at(0).unwrap()?;
        assert_eq!(sheet.get_size(), (126, 1));
        assert_eq!(sheet[(1, 0)], Data::Float(124.));
        assert_eq!(sheet[(125, 0)], Data::Float(0.));
        drop(book);
        assert!(s.call("export_excel", input).await.is_err());
    }
    for name in [
        "../escape.xlsx",
        r"..\escape.xlsx",
        "/escape.xlsx",
        r"C:\escape.xlsx",
        r"\\host\share\escape.xlsx",
        "report.xlsx:stream.xlsx",
        "NUL.xlsx",
        "plain.csv",
    ] {
        assert!(s
            .call("export_excel", json!({"resultId":id, "fileName":name}))
            .await
            .is_err());
    }
    for bad in [
        json!({}),
        json!({"snapshotId":snap["id"],"resultId":id}),
        json!({"snapshotId":source_id}),
    ] {
        assert!(s.call("export_excel", bad).await.is_err());
    }
    #[cfg(unix)]
    {
        let outside = s._dir.path().join("outside.xlsx");
        std::os::unix::fs::symlink(&outside, s.core.engine.directory.join("link.xlsx"))?;
        assert!(s
            .call(
                "export_excel",
                json!({"resultId":id,"fileName":"link.xlsx"})
            )
            .await
            .is_err());
        assert!(!outside.exists());
    }
    Ok(())
}

#[tokio::test]
async fn disabling_mcp_disconnects_local_clients_and_removes_discovery() -> Result<()> {
    use tokio::io::AsyncReadExt;
    let s = Server::new().await?;
    let root = s._dir.path().join("cache");
    let (mut client, bridge) = tokio::io::duplex(4096);
    let relay = tokio::spawn({
        let root = root.clone();
        async move { stdio::bridge(&root, tokio::io::split(bridge)).await }
    });
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    client.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}}\n").await?;
    let mut reader = tokio::io::BufReader::new(&mut client);
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut response)).await??;
    assert_eq!(
        serde_json::from_str::<Value>(&response)?["result"]["serverInfo"]["name"],
        "LedgerView"
    );
    s.control.shutdown().await?;
    let mut trailing = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut trailing)).await??;
    tokio::time::timeout(Duration::from_secs(5), relay).await???;
    assert!(!root.join("session").exists());
    assert!(
        stdio::bridge(&root, (tokio::io::empty(), tokio::io::sink()))
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn result_quota_cleans_partial_files_and_evicts_the_oldest_unleased_result() -> Result<()> {
    let s = Server::new().await?;
    let ct = CancellationToken::new();
    let sql = "SELECT 1 AS n";
    let run = |single, total| query::run(&s.core, sql, &ct, query::Limits { single, total });
    let error = run(1, 100).err().unwrap();
    assert!(error.to_string().contains("byte limit"), "{error}");
    assert_eq!(std::fs::read_dir(&s.core.cache.directory)?.count(), 0);
    let first = run(10000, 10000)?;
    let bytes = std::fs::metadata(&first.dataset.source_file)?.len();
    let active_id = first.dataset.id.clone();
    let oldest = run(bytes, 2 * bytes)?.dataset.id.clone();
    let newest = run(bytes, 2 * bytes)?.dataset.id.clone();
    assert!(s.core.result(&active_id).is_ok() && s.core.result(&newest).is_ok());
    assert!(s.core.result(&oldest).is_err());
    drop(first);
    s.control.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn cancelling_an_active_query_discards_its_output_and_allows_another_query() -> Result<()> {
    let s = Server::new().await?;
    let core = s.core.clone();
    let ct = CancellationToken::new();
    let worker_ct = ct.clone();
    let worker = tokio::task::spawn_blocking(move || {
        query::run(
            &core,
            "SELECT sum(sin(i)) FROM range(1000000000) t(i)",
            &worker_ct,
            query::RESULT_LIMITS,
        )
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while std::fs::read_dir(&s.core.cache.directory).unwrap().count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    ct.cancel();
    let error = tokio::time::timeout(Duration::from_secs(3), worker)
        .await??
        .err()
        .unwrap();
    assert!(error.to_string().contains("cancelled"), "{error}");
    assert_eq!(std::fs::read_dir(&s.core.cache.directory)?.count(), 0);
    assert_eq!(
        s.call("query", json!({"sql":"SELECT 1 AS n"})).await?["rows"],
        json!([["1"]])
    );
    s.control.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn shutting_down_during_snapshot_export_cleans_the_workbook_without_waiting_for_the_grid(
) -> Result<()> {
    let s = Server::new().await?;
    let result = s
        .call("query", json!({"sql":"SELECT i FROM range(150000) t(i)"}))
        .await?;
    let snapshot = s
        .call(
            "save_snapshot",
            json!({"resultId":result["resultId"], "name":"Export"}),
        )
        .await?;
    let args =
        serde_json::from_value(json!({"snapshotId":snapshot["id"], "fileName":"cancelled.xlsx"}))?;
    let core = s.core.clone();
    let folder = core.engine.directory.clone();
    let files = || -> std::io::Result<std::collections::BTreeSet<_>> {
        std::fs::read_dir(&folder)?
            .map(|entry| entry.map(|e| e.file_name()))
            .collect()
    };
    let initial = files()?;
    // An unrelated desktop operation may hold its connection for the entire export.
    let _grid = s.core.engine.conn.lock().unwrap();
    let job =
        tokio::task::spawn_blocking(move || core.export_excel(args, &CancellationToken::new()));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !files().unwrap().iter().any(|f| !initial.contains(f)) {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await?;
    tokio::time::timeout(Duration::from_secs(3), s.control.shutdown()).await??;
    assert!(job.await?.is_err());
    assert_eq!(files()?, initial);
    Ok(())
}

#[tokio::test]
async fn a_claimed_notebook_edit_waits_for_the_actual_save_outcome() -> Result<()> {
    let s = Server::new().await?;
    let args = serde_json::from_value(json!({"name":"Notes","cells":[]}))?;
    let tools = Tools(s.core.clone());
    let request = tokio::spawn(async move { tools.apply_edit(args).await });
    let ticket = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(ticket) = s
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["type"] == "edit")
                .and_then(|e| e["ticket"].as_str())
                .map(str::to_owned)
            {
                break ticket;
            }
            tokio::task::yield_now().await;
        }
    })
    .await?;
    s.core
        .edits
        .lock()
        .unwrap()
        .get_mut(&ticket)
        .unwrap()
        .claimed = true;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::task::yield_now().await;
    assert!(!request.is_finished());
    let pending = json!({"id":"example","applied":true,"saveStatus":"pending"});
    s.core
        .edits
        .lock()
        .unwrap()
        .remove(&ticket)
        .unwrap()
        .reply
        .send(Ok(pending.clone()))
        .unwrap();
    assert_eq!(request.await??, pending);
    tokio::time::resume();
    s.control.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn disconnecting_an_http_client_interrupts_the_query_and_frees_the_slot() -> Result<()> {
    let s = Server::new().await?;
    let post = s
        .post(
            "tools/call",
            json!({"name":"query","arguments":{
                "sql":"SELECT sum(sin(i)) FROM range(1000000000) t(i)"
            }}),
        )
        .bearer_auth("test-token");
    let request = tokio::spawn(async move { post.send().await });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !s
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "begin")
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await?;
    request.abort();
    let _ = request.await;
    let next = tokio::time::timeout(
        Duration::from_secs(5),
        s.call("query", json!({"sql":"SELECT 2"})),
    )
    .await??;
    assert_eq!(next["rows"], json!([["2"]]));
    assert!(s
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| e["type"] == "finish"
            && e["error"]
                .as_str()
                .is_some_and(|msg| msg.contains("cancelled"))));
    s.control.shutdown().await?;
    Ok(())
}
