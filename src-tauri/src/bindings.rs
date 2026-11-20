//! Pair DuckDB's prepare/execute log messages with the exact positional values of that execution.
use duckdb::{params_from_iter, Connection, Row, Statement};
use serde::Serialize;
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LoggedStatement {
    pub sql: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<String>,
}

pub struct BindingTrace {
    prefix: String,
    params: Mutex<Vec<Vec<String>>>,
}

thread_local! {
    // A request is dispatched synchronously on one worker. Only its observer shares this trace.
    static ACTIVE: RefCell<Option<Arc<BindingTrace>>> = const { RefCell::new(None) };
}

impl BindingTrace {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            prefix: format!("/*lv_bind_{}_", Uuid::new_v4().simple()),
            params: Mutex::new(Vec::new()),
        })
    }

    pub fn capture<R>(self: &Arc<Self>, run: impl FnOnce() -> R) -> R {
        struct Restore(Option<Arc<BindingTrace>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                ACTIVE.set(self.0.take());
            }
        }
        let _scope = Restore(ACTIVE.replace(Some(self.clone())));
        run()
    }

    pub fn resolve(&self, message: String) -> LoggedStatement {
        if let Some((before, tag)) = message.split_once(&self.prefix) {
            if let Some((index, after)) = tag.split_once("*/ ") {
                let params = index
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| self.params.lock().unwrap().get(i).cloned());
                if let Some(params) = params {
                    return LoggedStatement {
                        sql: format!("{before}{after}"),
                        params,
                    };
                }
            }
        }
        LoggedStatement {
            sql: message,
            params: vec![],
        }
    }
}

fn prepare<'db, S: AsRef<str>>(
    conn: &'db Connection,
    sql: &str,
    values: &[S],
) -> duckdb::Result<Statement<'db>> {
    let tagged = ACTIVE.with_borrow(|trace| {
        let trace = trace.as_ref().filter(|_| !values.is_empty())?;
        let split = sql.find(' ')? + 1;
        let mut params = trace.params.lock().unwrap();
        let index = params.len();
        params.push(values.iter().map(|v| v.as_ref().to_owned()).collect());
        // DuckDB can log the same SQL for both prepare and execute. A per-call ID also
        // distinguishes repeated executions with different values. Values never enter the SQL.
        // DuckDB discards comments before the first SQL token when preparing a statement.
        // Keep the marker inside the statement, immediately after its leading keyword.
        Some(format!(
            "{}{}{index}*/ {}",
            &sql[..split],
            trace.prefix,
            &sql[split..]
        ))
    });
    conn.prepare(tagged.as_deref().unwrap_or(sql))
}

pub fn execute(conn: &Connection, sql: &str, values: &[impl AsRef<str>]) -> duckdb::Result<usize> {
    prepare(conn, sql, values)?.execute(params_from_iter(values.iter().map(|v| v.as_ref())))
}

pub fn query_row<T>(
    conn: &Connection,
    sql: &str,
    values: &[impl AsRef<str>],
    map: impl FnOnce(&Row<'_>) -> duckdb::Result<T>,
) -> duckdb::Result<T> {
    prepare(conn, sql, values)?.query_row(params_from_iter(values.iter().map(|v| v.as_ref())), map)
}

pub fn query_rows<T>(
    conn: &Connection,
    sql: &str,
    values: &[impl AsRef<str>],
    map: impl FnMut(&Row<'_>) -> duckdb::Result<T>,
) -> duckdb::Result<Vec<T>> {
    let mut stmt = prepare(conn, sql, values)?;
    let rows = stmt.query_map(params_from_iter(values.iter().map(|v| v.as_ref())), map)?;
    rows.collect()
}
