#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod filter;
mod ledger;

use anyhow::{Context, Result};
use duckdb::{Connection, InterruptHandle};
use filter::{Filters, Sort};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Restore,
    DiskSpace,
    FileSize {
        path: PathBuf,
    },
    Open {
        path: PathBuf,
    },
    Describe {
        id: String,
    },
    Remove {
        id: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Page {
        id: String,
        filters: Filters,
        sort: Vec<Sort>,
        columns: Vec<String>,
        start: u64,
        limit: u32,
    },
    Count {
        id: String,
        filters: Filters,
    },
    Distinct {
        id: String,
        filters: Filters,
        column: String,
        limited: bool,
    },
    Aggregate {
        id: String,
        filters: Filters,
        column: String,
    },
    Snapshot {
        id: String,
        filters: Filters,
        sort: Vec<Sort>,
        columns: Vec<String>,
        description: String,
    },
    Export {
        id: String,
        path: PathBuf,
    },
    Clipboard {
        id: String,
    },
}

struct Engine {
    conn: Mutex<Connection>,
    active: Mutex<Option<(String, Arc<InterruptHandle>)>>,
    directory: PathBuf,
    persistent: bool,
}

impl Engine {
    fn new(directory: PathBuf) -> Result<Self> {
        let db = directory.join("ledger.duckdb");
        let connection = fs::create_dir_all(&directory)
            .map_err(anyhow::Error::from)
            .and_then(|_| Ok(Connection::open(&db)?));
        let (conn, persistent) = match connection {
            Ok(conn) => (conn, true),
            // A locked or damaged existing catalog must be reported, not silently bypassed.
            Err(e) if db.exists() => return Err(e.context("Opening LedgerView catalog")),
            Err(_) => (Connection::open_in_memory()?, false),
        };
        ledger::init(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            active: Mutex::new(None),
            directory,
            persistent,
        })
    }

    fn execute(&self, request: Request, token: String, trace: bool) -> Result<Value> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        *self.active.lock().unwrap() = Some((token, conn.interrupt_handle()));
        let result = if trace {
            self.trace_request(&conn, request)
        } else {
            self.dispatch(&conn, request)
        };
        *self.active.lock().unwrap() = None;
        result
    }

    fn trace_request(&self, conn: &Connection, request: Request) -> Result<Value> {
        conn.execute_batch("CALL enable_logging('QueryLog', storage='memory')")?;
        let started = std::time::Instant::now();
        let result = self.dispatch(conn, request);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
        conn.execute_batch("CALL disable_logging()")?;
        let mut stmt = conn.prepare("SELECT message FROM duckdb_logs() WHERE type='QueryLog' AND message NOT LIKE '%disable_logging()%' ORDER BY timestamp")?;
        let queries = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?;
        conn.execute_batch("CALL truncate_duckdb_logs()")?;
        Ok(match result {
            Ok(value) => json!({"result":value,"queries":queries,"elapsedMs":elapsed_ms}),
            Err(error) => {
                json!({"error":format!("{error:#}"),"queries":queries,"elapsedMs":elapsed_ms})
            }
        })
    }

    fn dispatch(&self, conn: &Connection, request: Request) -> Result<Value> {
        use Request::*;
        let result = match request {
            Restore => json!({"persistent": self.persistent, "catalog": ledger::restore(conn)?}),
            DiskSpace => json!(fs2::available_space(&self.directory).ok()),
            FileSize { path } => json!(fs::metadata(path)?.len()),
            Open { path } => json!(ledger::open(conn, &path)?),
            Describe { id } => json!(ledger::dataset(conn, &id)?),
            Remove { id } => {
                ledger::remove(conn, &ledger::dataset(conn, &id)?)?;
                Value::Null
            }
            Rename { id, name } => {
                ledger::rename(conn, &mut ledger::dataset(conn, &id)?, name)?;
                Value::Null
            }
            Count { id, filters } => {
                json!(ledger::count(conn, &ledger::dataset(conn, &id)?, &filters)?)
            }
            Page {
                id,
                filters,
                sort,
                columns,
                start,
                limit,
            } => json!(ledger::page(
                conn,
                &ledger::dataset(conn, &id)?,
                &filters,
                &sort,
                &columns,
                start,
                limit
            )?),
            Distinct {
                id,
                filters,
                column,
                limited,
            } => json!(ledger::distinct(
                conn,
                &ledger::dataset(conn, &id)?,
                &filters,
                &column,
                limited
            )?),
            Aggregate {
                id,
                filters,
                column,
            } => json!(ledger::aggregate(
                conn,
                &ledger::dataset(conn, &id)?,
                &filters,
                &column
            )?),
            Snapshot {
                id,
                filters,
                sort,
                columns,
                description,
            } => json!(ledger::create_snapshot(
                conn,
                &ledger::dataset(conn, &id)?,
                filters,
                sort,
                columns,
                description
            )?),
            Clipboard { id } => json!(ledger::clipboard(conn, &ledger::dataset(conn, &id)?)?),
            Export { id, path } => {
                ledger::export(conn, &ledger::dataset(conn, &id)?, &path)?;
                Value::Null
            }
        };
        Ok(result)
    }
}

struct Database(Result<Arc<Engine>, String>);

#[tauri::command]
async fn ledger_request(
    database: State<'_, Database>,
    request: Request,
    token: String,
    trace: Option<bool>,
) -> Result<Value, String> {
    let engine = database.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .execute(request, token, trace.unwrap_or(false))
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_query(database: State<'_, Database>, token: String) {
    let Ok(engine) = &database.0 else {
        return;
    };
    if let Some((active, handle)) = engine.active.lock().unwrap().as_ref() {
        if *active == token {
            handle.interrupt();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let engine = app
                .path()
                .app_data_dir()
                .context("Locating app data")
                .and_then(Engine::new)
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            app.manage(Database(engine));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ledger_request, cancel_query])
        .run(tauri::generate_context!())
        .expect("Starting LedgerView");
}

#[cfg(test)]
mod tests;
