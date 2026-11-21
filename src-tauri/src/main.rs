#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bindings;
mod excel;
mod filter;
mod ledger;
mod mcp;
mod notebooks;
mod updates;

use anyhow::{Context, Result};
use bindings::{BindingTrace, LoggedStatement};
use duckdb::{Connection, InterruptHandle};
use filter::{Filters, Sort};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{ipc::JavaScriptChannelId, Manager, State, Webview};

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Request {
    Restore,
    CreateNotebook {
        cell_name: String,
    },
    CreateNotebookDraft {
        draft: notebooks::Draft,
    },
    SaveNotebook {
        book: notebooks::Notebook,
    },
    OpenNotebook {
        path: PathBuf,
    },
    ExportNotebook {
        id: String,
        path: PathBuf,
    },
    DeleteNotebook {
        id: String,
    },
    NotebookSources,
    SqlVocabulary,
    RunNotebook {
        sql: String,
        id: String,
        cell: usize,
        snapshot: bool,
    },
    NotebookPage {
        id: String,
        cell: usize,
        start: u64,
    },
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

enum QueryState {
    Queued,
    Running(Arc<InterruptHandle>),
    Cancelled,
}

fn open_catalog(directory: &Path, db: &Path) -> Result<Connection> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        anyhow::ensure!(
            directory.symlink_metadata()?.is_dir(),
            "Invalid workspace directory"
        );
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        for path in [db.to_owned(), db.with_extension("duckdb.wal")] {
            match path.symlink_metadata() {
                Ok(meta) => {
                    anyhow::ensure!(meta.is_file(), "Invalid workspace database file");
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
        }
    }
    let conn = Connection::open(db)?;
    #[cfg(unix)]
    fs::set_permissions(db, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(conn)
}

struct Engine {
    conn: Mutex<Connection>,
    readers: Mutex<Connection>,
    requests: Mutex<HashMap<String, QueryState>>,
    directory: PathBuf,
    persistent: bool,
}

impl Engine {
    fn new(directory: PathBuf) -> Result<Self> {
        let db = directory.join("ledger.duckdb");
        let (conn, persistent) = match open_catalog(&directory, &db) {
            Ok(conn) => (conn, true),
            // A locked or damaged existing catalog must be reported, not silently bypassed.
            Err(e) if db.exists() => return Err(e.context("Opening LedgerView catalog")),
            Err(_) => (Connection::open_in_memory()?, false),
        };
        ledger::init(&conn)?;
        mcp::settings::init(&conn)?;
        Ok(Self {
            readers: Mutex::new(conn.try_clone()?),
            conn: Mutex::new(conn),
            requests: Default::default(),
            directory,
            persistent,
        })
    }

    fn reader(&self) -> Result<Connection> {
        Ok(self.readers.lock().unwrap().try_clone()?)
    }

    fn register(&self, token: &str) -> Result<()> {
        let mut requests = self.requests.lock().unwrap();
        anyhow::ensure!(!requests.contains_key(token), "Duplicate request");
        requests.insert(token.to_owned(), QueryState::Queued);
        Ok(())
    }

    fn cancel(&self, token: &str) {
        if let Some(state) = self.requests.lock().unwrap().get_mut(token) {
            if let QueryState::Running(handle) = state {
                handle.interrupt();
            }
            *state = QueryState::Cancelled;
        }
    }

    #[cfg(test)]
    fn execute(
        &self,
        request: Request,
        token: String,
        trace: bool,
        listener: Option<&(dyn Fn(LoggedStatement) + Sync)>,
    ) -> Result<Value> {
        self.register(&token)?;
        self.execute_registered(request, token, trace, listener)
    }

    fn execute_registered(
        &self,
        request: Request,
        token: String,
        trace: bool,
        listener: Option<&(dyn Fn(LoggedStatement) + Sync)>,
    ) -> Result<Value> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Database unavailable"))?;
        {
            let mut requests = self.requests.lock().unwrap();
            if matches!(requests.get(&token), Some(QueryState::Cancelled)) {
                requests.remove(&token);
                anyhow::bail!("Query cancelled");
            }
            requests.insert(token.clone(), QueryState::Running(conn.interrupt_handle()));
        }
        let result = if trace {
            self.trace_request(&conn, request, listener)
        } else {
            self.dispatch(&conn, request)
        };
        self.requests.lock().unwrap().remove(&token);
        result
    }

    fn trace_request(
        &self,
        conn: &Connection,
        request: Request,
        on_statement: Option<&(dyn Fn(LoggedStatement) + Sync)>,
    ) -> Result<Value> {
        let worker_id: u64 = conn.query_row("SELECT current_connection_id()", [], |r| r.get(0))?;
        let bindings = BindingTrace::new();
        let observer = on_statement.and_then(|_| conn.try_clone().ok());
        conn.execute_batch(
            "CALL enable_logging('QueryLog', storage='memory', storage_buffer_size=0)",
        )?;
        let started = std::time::Instant::now();
        let (result, elapsed_ms) = std::thread::scope(|scope| {
            let (done, stop) = std::sync::mpsc::channel();
            if let (Some(observer), Some(notify)) = (observer, on_statement) {
                // Listen on a second connection so a long query cannot block its own diagnostics.
                let bindings = bindings.clone();
                scope.spawn(move || {
                    let mut previous = String::new();
                    while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                        stop.recv_timeout(std::time::Duration::from_millis(200))
                    {
                        let latest = observer.query_row(
                            "SELECT message FROM duckdb_logs WHERE connection_id=? AND type='QueryLog' ORDER BY timestamp DESC LIMIT 1",
                            [worker_id], |r| r.get::<_, String>(0),
                        );
                        if let Ok(sql) = latest {
                            if previous != sql {
                                previous.clone_from(&sql);
                                notify(bindings.resolve(sql));
                            }
                        }
                    }
                });
            }
            let result = bindings.capture(|| self.dispatch(conn, request));
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
            let _ = done.send(());
            (result, elapsed_ms)
        });
        conn.execute_batch("CALL disable_logging()")?;
        let mut stmt = conn.prepare("SELECT message FROM duckdb_logs WHERE connection_id=? AND type='QueryLog' AND message <> 'CALL disable_logging()' ORDER BY timestamp")?;
        let queries = stmt
            .query_map([worker_id], |r| Ok(bindings.resolve(r.get(0)?)))?
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
            Restore => {
                json!({"persistent": self.persistent, "catalog": ledger::restore(conn)?, "notebooks": notebooks::list(conn)?})
            }
            CreateNotebook { cell_name } => json!(notebooks::create(conn, cell_name)?),
            CreateNotebookDraft { draft } => json!(notebooks::create_draft(conn, draft)?),
            SaveNotebook { book } => {
                notebooks::save(conn, &book)?;
                Value::Null
            }
            OpenNotebook { path } => json!(notebooks::open(conn, &path)?),
            ExportNotebook { id, path } => {
                notebooks::export(conn, &id, &path)?;
                Value::Null
            }
            DeleteNotebook { id } => {
                notebooks::delete(conn, &id)?;
                Value::Null
            }
            SqlVocabulary => json!(notebooks::sql_vocabulary(conn)?),
            NotebookSources => json!(notebooks::notebook_sources(conn)?),
            RunNotebook {
                id,
                cell,
                sql,
                snapshot,
            } => notebooks::run(conn, &id, cell, &sql, snapshot)?,
            NotebookPage { id, cell, start } => {
                json!(notebooks::result_page(conn, &id, cell, start)?)
            }
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

struct Database(Mutex<Result<Arc<Engine>, String>>);
impl Database {
    fn engine(&self) -> Result<Arc<Engine>, String> {
        self.0.lock().unwrap().clone()
    }

    fn close(&self) {
        *self.0.lock().unwrap() = Err("Workspace closed".into());
    }
}

#[tauri::command]
async fn ledger_request(
    database: State<'_, Database>,
    request: Request,
    token: String,
    trace: Option<bool>,
    webview: Webview,
    on_statement: Option<JavaScriptChannelId>,
) -> Result<Value, String> {
    let engine = database.engine()?;
    engine.register(&token).map_err(|e| e.to_string())?;
    let on_statement = on_statement.map(|id| id.channel_on::<_, LoggedStatement>(webview));
    tauri::async_runtime::spawn_blocking(move || {
        let notify = |sql| {
            if let Some(channel) = &on_statement {
                let _ = channel.send(sql);
            }
        };
        let listener: Option<&(dyn Fn(LoggedStatement) + Sync)> =
            on_statement.as_ref().map(|_| &notify as _);
        engine
            .execute_registered(request, token, trace.unwrap_or(false), listener)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_query(database: State<'_, Database>, token: String) {
    let Ok(engine) = database.engine() else {
        return;
    };
    engine.cancel(&token);
}

#[tauri::command]
async fn open_workspace_directory(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&directory)?;
        open::that(directory)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--mcp-stdio")) {
        if let Err(err) = mcp::stdio::run() {
            eprintln!("LedgerView MCP: {err:#}");
            std::process::exit(1);
        }
        return;
    }
    // Apply before starting native workers: DuckDB can recreate its WAL on any write.
    #[cfg(unix)]
    {
        let private = rustix::fs::Mode::from_bits_truncate(0o077);
        let inherited = rustix::process::umask(private);
        rustix::process::umask(inherited | private);
    }
    tauri::Builder::default()
        .manage(mcp::Control::default())
        .manage(updates::Updates::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if let Err(error) =
                mcp::cache_root(app.handle()).and_then(|root| mcp::clean_stale(&root))
            {
                eprintln!("Cleaning previous MCP cache: {error:#}");
            }
            let engine = app
                .path()
                .app_data_dir()
                .context("Locating app data")
                .and_then(Engine::new)
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"));
            app.manage(Database(Mutex::new(engine)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::check_update,
            updates::download_update,
            updates::install_update,
            ledger_request,
            cancel_query,
            open_workspace_directory,
            mcp::settings::mcp_info,
            mcp::settings::mcp_set_port,
            mcp::settings::mcp_set_enabled,
            mcp::settings::mcp_regenerate_token,
            mcp::settings::mcp_copy_connection,
            mcp::mcp_page,
            mcp::mcp_snapshot_preview,
            mcp::mcp_claim_edit,
            mcp::mcp_edit_reply
        ])
        .build(tauri::generate_context!())
        .expect("Starting LedgerView")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<mcp::Control>();
                if let Err(error) = tauri::async_runtime::block_on(state.shutdown()) {
                    eprintln!("Cleaning MCP cache on exit: {error:#}");
                }
                app.state::<Database>().close();
            }
        });
}

#[cfg(test)]
mod tests;
