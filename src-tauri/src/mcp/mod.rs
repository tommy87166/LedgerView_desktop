mod query;

use crate::{ledger, notebooks, Database, Engine};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use duckdb::Connection;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    tool, tool_handler, tool_router, ServerHandler,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type EventSink = dyn Fn(Value) -> Result<()> + Send + Sync;
struct PendingEdit {
    claimed: bool,
    reply: oneshot::Sender<Result<Value, String>>,
}

struct Workspace {
    engine: Arc<Engine>,
    emit: Box<EventSink>,
    files: Mutex<query::Files>,
    query_slot: Arc<Semaphore>,
    edits: Mutex<HashMap<String, PendingEdit>>,
    stop: CancellationToken,
}

impl Workspace {
    fn check_enabled(&self) -> Result<()> {
        ensure!(!self.stop.is_cancelled(), "MCP is disabled");
        Ok(())
    }
    fn run_query(&self, args: QueryArgs) -> Result<Value> {
        self.check_enabled()?;
        let token = Uuid::new_v4().to_string();
        (self.emit)(json!({ "type": "begin", "token": token, "sql": args.sql }))?;
        let started = Instant::now();
        let result = query::run(self, &args.sql).and_then(|file| {
            if args.preview {
                (self.emit)(json!({ "type": "preview", "resultId": file.dataset.id }))?;
                Ok(json!({ "resultId": file.dataset.id, "total": file.dataset.row_count, "preview": true }))
            } else {
                query::page(&file, 0)
            }
        });
        let _ = (self.emit)(json!({
            "type": "finish", "token": token, "sql": args.sql,
            "elapsedMs": started.elapsed().as_secs_f64() * 1000.,
            "error": result.as_ref().err().map(ToString::to_string)
        }));
        result
    }

    fn result(&self, id: &str) -> Result<Arc<query::ResultFile>> {
        self.files.lock().unwrap().result(id)
    }
    fn db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self
            .engine
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace unavailable"))?;
        self.check_enabled()?;
        f(&conn)
    }
}

#[derive(Clone)]
struct Tools(Arc<Workspace>);

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryArgs {
    sql: String,
    /// Show a table in LedgerView and return only metadata to the caller.
    #[serde(default)]
    preview: bool,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageArgs {
    result_id: String,
    #[serde(default)]
    start: u64,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotArgs {
    result_id: String,
    name: String,
    /// Existing AI-created snapshot to replace atomically, retaining its ID.
    replace_id: Option<String>,
    /// Navigate the visible LedgerView window to the saved snapshot.
    #[serde(default)]
    focus: bool,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CellEdit {
    /// Preserve the slot from list_notebooks for an existing cell. Omit for a new cell.
    slot: Option<u32>,
    name: String,
    sql: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditArgs {
    /// ID from list_notebooks. Omit to create a notebook.
    id: Option<String>,
    /// Required when editing an existing notebook.
    expected_revision: Option<String>,
    name: String,
    /// The desired ordered cells. Omit a previous slot to remove that cell.
    cells: Vec<CellEdit>,
}

fn revision(book: &Value) -> String {
    let mut hash = DefaultHasher::new();
    book.to_string().hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn reply(result: Result<Value>) -> CallToolResult {
    match result {
        Ok(v) => CallToolResult::structured(v),
        Err(e) => CallToolResult::error(vec![ContentBlock::text(format!("{e:#}"))]),
    }
}
async fn blocking(f: impl FnOnce() -> Result<Value> + Send + 'static) -> Result<Value> {
    tokio::task::spawn_blocking(f).await?
}

#[tool_router]
impl Tools {
    #[tool(
        description = "List workspace tables and snapshots with their SQL aliases, columns and types."
    )]
    async fn list_sources(&self) -> CallToolResult {
        let core = self.0.clone();
        reply(
            blocking(move || {
                core.db(|conn| {
                    let mut sources = Vec::new();
                    for (name, ds) in notebooks::sources(conn)? {
                        sources.push(json!({ "id": ds.id, "name": name, "snapshot": ds.ephemeral, "columns": ds.columns }));
                    }
                    Ok(json!({"sources":sources}))
                })
            })
            .await,
        )
    }

    #[tool(
        description = "Run one DuckDB SELECT against workspace sources. Returns columns and up to 100 rows. Set preview=true to show the desktop grid without returning data rows. The last eight successful results can be paged or saved by resultId."
    )]
    async fn query(&self, Parameters(args): Parameters<QueryArgs>) -> CallToolResult {
        let core = self.0.clone();
        let permit = core
            .query_slot
            .clone()
            .acquire_owned()
            .await
            .expect("query semaphore stays open");
        reply(
            blocking(move || {
                // Keep the slot until DuckDB stops even if the client disconnects early.
                let _permit = permit;
                core.run_query(args)
            })
            .await,
        )
    }

    #[tool(
        description = "Read another page of a query result. Pass the next offset from the previous response."
    )]
    async fn result_page(&self, Parameters(args): Parameters<PageArgs>) -> CallToolResult {
        let core = self.0.clone();
        reply(
            blocking(move || {
                core.check_enabled()?;
                query::page(core.result(&args.result_id)?.as_ref(), args.start)
            })
            .await,
        )
    }

    #[tool(
        description = "Save the entire query result as an AI-owned snapshot. For later iterations pass its ID as replaceId. Set focus=true to take the user to the snapshot."
    )]
    async fn save_snapshot(&self, Parameters(args): Parameters<SnapshotArgs>) -> CallToolResult {
        let core = self.0.clone();
        reply(
            blocking(move || {
                let file = core.result(&args.result_id)?;
                let (snap, ds) = core.db(|conn| {
                    let tx = conn.unchecked_transaction()?;
                    let columns = file
                        .dataset
                        .columns
                        .iter()
                        .map(|c| c.name.clone())
                        .collect();
                    let snap = ledger::snapshot_in_transaction(
                        &tx,
                        &file.dataset,
                        Default::default(),
                        vec![],
                        columns,
                        file.sql.clone(),
                        ledger::SnapshotTarget::Ai {
                            name: args.name,
                            replace_id: args.replace_id,
                        },
                    )?;
                    let ds = ledger::dataset(&tx, &snap.id)?;
                    core.check_enabled()?;
                    tx.commit()?;
                    Ok((snap, ds))
                })?;
                (core.emit)(
                    json!({"type":"snapshot","snapshot":snap,"dataset":ds,"focus":args.focus}),
                )?;
                Ok(json!({"id":snap.id,"name":snap.display_name,"total":snap.row_count}))
            })
            .await,
        )
    }

    #[tool(
        description = "Read all notebooks, cell slots, names, SQL, and revision tokens for editing."
    )]
    async fn list_notebooks(&self) -> CallToolResult {
        let core = self.0.clone();
        reply(
            blocking(move || {
                core.db(|conn| {
                    let mut books = vec![];
                    for book in notebooks::list(conn)? {
                        let mut value = serde_json::to_value(book)?;
                        value["revision"] = json!(revision(&value));
                        for (index, cell) in value["cells"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .enumerate()
                        {
                            if cell["slot"].is_null() {
                                cell["slot"] = json!(index);
                            }
                        }
                        books.push(value);
                    }
                    Ok(json!({"notebooks":books}))
                })
            })
            .await,
        )
    }

    #[tool(
        description = "Create or edit a notebook without executing its SQL. Supply the ID and expectedRevision for an existing notebook. Keep existing cell slots, omit slots for new cells. An unsaved concurrent desktop edit is preserved."
    )]
    async fn edit_notebook(&self, Parameters(args): Parameters<EditArgs>) -> CallToolResult {
        reply(self.apply_edit(args).await)
    }
}

impl Tools {
    async fn apply_edit(&self, args: EditArgs) -> Result<Value> {
        self.0.check_enabled()?;
        ensure!(!args.name.trim().is_empty(), "Enter a notebook name");
        let core = self.0.clone();
        let id = args.id.clone();
        let before = blocking(move || {
            core.db(|conn| {
                if let Some(id) = id {
                    Ok(serde_json::to_value(notebooks::get(conn, &id)?)?)
                } else {
                    Ok(Value::Null)
                }
            })
        })
        .await?;
        if !before.is_null() {
            ensure!(
                args.expected_revision == Some(revision(&before)),
                "Notebook changed. Read the latest revision"
            );
        }
        let ticket = Uuid::new_v4().to_string();
        let (send, recv) = oneshot::channel();
        self.0.edits.lock().unwrap().insert(
            ticket.clone(),
            PendingEdit {
                claimed: false,
                reply: send,
            },
        );
        let result = async {
            (self.0.emit)(json!({
                "type": "edit", "ticket": ticket, "before": before,
                "name": args.name, "cells": args.cells
            }))?;
            tokio::select! {
                _ = self.0.stop.cancelled() => anyhow::bail!("MCP is disabled"),
                response = tokio::time::timeout(Duration::from_secs(30), recv) =>
                    Ok(response.context("Desktop save was not acknowledged. Read notebooks before retrying")??.map_err(anyhow::Error::msg)?),
            }
        }.await;
        self.0.edits.lock().unwrap().remove(&ticket);
        result
    }
}

#[tool_handler(
    name = "LedgerView",
    instructions = "Use list_sources for SQL aliases. Quote identifiers when needed. Query results and notebook edits stay local unless returned to the client."
)]
impl ServerHandler for Tools {}

#[derive(Clone, Serialize)]
pub(crate) struct Info {
    url: String,
    token: String,
}
struct Running {
    info: Info,
    core: Arc<Workspace>,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
}
#[derive(Default)]
pub(crate) struct Control(tokio::sync::Mutex<Option<Running>>);

#[tauri::command]
pub(crate) async fn mcp_info(state: State<'_, Control>) -> Result<Option<Info>, String> {
    Ok(state.0.lock().await.as_ref().map(|r| r.info.clone()))
}
#[tauri::command]
pub(crate) async fn mcp_set_enabled(
    enabled: bool,
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, Control>,
) -> Result<Option<Info>, String> {
    let mut running = state.0.lock().await;
    if !enabled {
        if let Some(previous) = running.take() {
            previous.core.stop.cancel();
            previous.server.abort();
            let _ = previous.server.await;
        }
        return Ok(None);
    }
    if let Some(r) = running.as_ref() {
        return Ok(Some(r.info.clone()));
    }
    let engine = database.0.clone()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 18476))
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let token = Uuid::new_v4().simple().to_string();
    let info = Info {
        url: format!("http://{address}/mcp"),
        token: token.clone(),
    };
    let core = Arc::new(Workspace {
        engine,
        emit: Box::new(move |event| {
            let show = event["type"] == "preview"
                || (event["type"] == "snapshot" && event["focus"] == true);
            app.emit_to("main", "mcp-workspace", event)?;
            if show {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        }),
        files: Default::default(),
        query_slot: Arc::new(Semaphore::new(1)),
        edits: Default::default(),
        stop: CancellationToken::new(),
    });
    let router = router(core.clone(), address.to_string(), token);
    let stop = core.stop.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
    });
    *running = Some(Running {
        info: info.clone(),
        core,
        server,
    });
    Ok(Some(info))
}

fn router(core: Arc<Workspace>, host: String, token: String) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts([host])
        .enforce_origin_validation()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_cancellation_token(core.stop.child_token());
    let service = StreamableHttpService::new(
        move || Ok(Tools(core.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let bearer = format!("Bearer {token}");
    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let authorized = req
                .headers()
                .get(header::AUTHORIZATION)
                .is_some_and(|h| h.as_bytes() == bearer.as_bytes());
            async move {
                if authorized {
                    Ok::<Response, StatusCode>(next.run(req).await)
                } else {
                    Err(StatusCode::UNAUTHORIZED)
                }
            }
        }))
}

#[tauri::command]
pub(crate) async fn mcp_page(
    result_id: String,
    start: u64,
    state: State<'_, Control>,
) -> Result<Value, String> {
    let file = state
        .0
        .lock()
        .await
        .as_ref()
        .ok_or("MCP is disabled")?
        .core
        .result(&result_id)
        .map_err(|e| e.to_string())?;
    blocking(move || query::page(&file, start))
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn mcp_claim_edit(
    ticket: String,
    state: State<'_, Control>,
) -> Result<(), String> {
    let state = state.0.lock().await;
    let core = &state.as_ref().ok_or("MCP is disabled")?.core;
    let mut edits = core.edits.lock().unwrap();
    let edit = edits.get_mut(&ticket).ok_or("Edit request expired")?;
    if edit.claimed || edit.reply.is_closed() {
        return Err("Edit request expired".into());
    }
    edit.claimed = true;
    Ok(())
}

#[tauri::command]
pub(crate) async fn mcp_edit_reply(
    ticket: String,
    result: Option<Value>,
    error: Option<String>,
    state: State<'_, Control>,
) -> Result<(), String> {
    let state = state.0.lock().await;
    let core = &state.as_ref().ok_or("MCP is disabled")?.core;
    let sender = core
        .edits
        .lock()
        .unwrap()
        .remove(&ticket)
        .ok_or("Edit request expired")?;
    let value = error.map_or_else(|| Ok(result.unwrap_or(Value::Null)), Err);
    sender
        .reply
        .send(value)
        .map_err(|_| "Edit request expired".into())
}

#[cfg(test)]
mod tests;
