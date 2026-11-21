mod cache;
mod export;
mod query;
pub(crate) mod settings;
pub(crate) mod stdio;
pub(crate) use cache::clean_stale;

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
use export::ExportArgs;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    service::RequestContext,
    tool, tool_handler, tool_router, RoleServer, ServerHandler,
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
use subtle::ConstantTimeEq;
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
    cache: Arc<cache::Cache>,
    query_slot: Arc<Semaphore>,
    edits: Mutex<HashMap<String, PendingEdit>>,
    exports: tokio_util::task::TaskTracker,
    stop: CancellationToken,
}

impl Workspace {
    fn check_enabled(&self) -> Result<()> {
        ensure!(!self.stop.is_cancelled(), "MCP is disabled");
        Ok(())
    }
    fn check_request(&self, cancel: &CancellationToken) -> Result<()> {
        self.check_enabled()?;
        ensure!(!cancel.is_cancelled(), "Request cancelled");
        Ok(())
    }

    fn run_query(&self, args: QueryArgs, cancel: &CancellationToken) -> Result<Value> {
        self.check_enabled()?;
        let token = Uuid::new_v4().to_string();
        (self.emit)(json!({ "type": "begin", "token": token, "sql": args.sql }))?;
        let started = Instant::now();
        let result = query::run(self, &args.sql, cancel, query::RESULT_LIMITS).and_then(|file| {
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

    fn save_ai_snapshot(&self, args: SnapshotArgs) -> Result<Value> {
        let file = self.result(&args.result_id)?;
        let access = self.cache.access()?;
        let (snap, ds) = self.db(|conn| {
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
            self.check_enabled()?;
            tx.commit()?;
            Ok((snap, ds))
        })?;
        drop(access);
        (self.emit)(json!({"type":"snapshot","snapshot":snap,"dataset":ds,"focus":args.focus}))?;
        Ok(json!({"id":snap.id,"name":snap.display_name,"total":snap.row_count}))
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
        description = "Run one DuckDB SELECT against workspace sources. Returns columns and up to 100 rows. Set preview=true to show the desktop grid without returning data rows. Results up to 2 GiB can be paged or saved by resultId. The cache retains up to eight results within 8 GiB."
    )]
    async fn query(
        &self,
        Parameters(args): Parameters<QueryArgs>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let core = self.0.clone();
        let cancel = context.ct.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let permit = tokio::select! {
            permit = core.query_slot.clone().acquire_owned() => permit.expect("query semaphore stays open"),
            _ = cancel.cancelled() => return reply(Err(anyhow::anyhow!("Request cancelled"))),
            _ = core.stop.cancelled() => return reply(Err(anyhow::anyhow!("MCP is disabled"))),
        };
        reply(
            blocking(move || {
                // Keep the slot until DuckDB stops even if the client disconnects early.
                let _permit = permit;
                core.run_query(args, &cancel)
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
        reply(blocking(move || core.save_ai_snapshot(args)).await)
    }

    #[tool(
        description = "Export one saved snapshot (snapshotId) or complete query result (resultId) to an Excel .xlsx file in the LedgerView workspace directory. fileName is optional and must be a filename only. Existing files are preserved."
    )]
    async fn export_excel(
        &self,
        Parameters(args): Parameters<ExportArgs>,
        context: RequestContext<RoleServer>,
    ) -> CallToolResult {
        let core = self.0.clone();
        let cancel = context.ct.child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        reply(blocking(move || core.export_excel(args, &cancel)).await)
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
        let (send, mut recv) = oneshot::channel();
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
            let reply = tokio::select! {
                value = &mut recv => value,
                _ = self.0.stop.cancelled() => anyhow::bail!("MCP closed. Check the notebook before retrying"),
                _ = tokio::time::sleep(Duration::from_secs(30)) => {
                    // Expire an unclaimed ticket atomically with claim_edit. Once claimed,
                    // the frontend may already have applied it or be queued for a save.
                    {
                        let mut edits = self.0.edits.lock().unwrap();
                        if edits.get(&ticket).is_some_and(|edit| !edit.claimed) {
                            edits.remove(&ticket);
                            anyhow::bail!("Desktop did not accept the notebook edit");
                        }
                    }
                    tokio::select! {
                        value = recv => value,
                        _ = self.0.stop.cancelled() => anyhow::bail!("MCP closed. Check the notebook before retrying"),
                    }
                }
            };
            reply.context("Desktop acknowledgement lost. Read the notebook before retrying")?.map_err(anyhow::Error::msg)
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

struct Running {
    url: String,
    token_hash: Arc<Mutex<String>>,
    core: Arc<Workspace>,
    server: tokio::task::JoinHandle<std::io::Result<()>>,
    local_server: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
pub(crate) struct Control(tokio::sync::Mutex<Option<Running>>);

const APP_IDENTIFIER: &str = "com.tommypai.ledgerview.desktop";
const CACHE_NAME: &str = "mcp-temp-v1";

pub(crate) fn cache_root(app: &AppHandle) -> Result<std::path::PathBuf> {
    Ok(app.path().app_cache_dir()?.join(CACHE_NAME))
}

async fn stop(running: &mut Option<Running>) -> Result<()> {
    if let Some(previous) = running.take() {
        previous.core.stop.cancel();
        previous.server.abort();
        let _ = previous.server.await;
        previous.local_server.await?;
        previous.core.exports.close();
        previous.core.exports.wait().await;
        tokio::task::spawn_blocking(move || previous.core.cache.close()).await??;
    }
    Ok(())
}

impl Control {
    async fn snapshot_preview(&self, result_id: String) -> Result<Value> {
        let core = self
            .0
            .lock()
            .await
            .as_ref()
            .context("MCP is disabled")?
            .core
            .clone();
        blocking(move || {
            core.save_ai_snapshot(SnapshotArgs {
                result_id,
                name: format!("AI_{}", &Uuid::new_v4().simple().to_string()[..8]),
                replace_id: None,
                focus: false,
            })
        })
        .await
    }

    pub(crate) async fn shutdown(&self) -> Result<()> {
        let mut running = self.0.lock().await;
        stop(&mut running).await
    }
}

fn router(core: Arc<Workspace>, host: String, token_hash: Arc<Mutex<String>>) -> Router {
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
    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let authorized = req
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|h| h.as_bytes().strip_prefix(b"Bearer "))
                .is_some_and(|value| {
                    bool::from(
                        settings::token_hash(value)
                            .as_bytes()
                            .ct_eq(token_hash.lock().unwrap().as_bytes()),
                    )
                });
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
pub(crate) async fn mcp_snapshot_preview(
    result_id: String,
    state: State<'_, Control>,
) -> Result<Value, String> {
    state
        .snapshot_preview(result_id)
        .await
        .map_err(|e| format!("{e:#}"))
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
