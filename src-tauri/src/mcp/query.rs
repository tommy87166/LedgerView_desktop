// Each MCP query gets its own DuckDB instance. File permissions and cancellation
// apply to this query without changing the desktop connection's settings.
use super::*;
use crate::ledger::{self, ident, literal, Dataset};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub(super) struct ResultFile {
    pub dataset: Dataset,
    pub sql: String,
    _directory: TempDir,
}

#[derive(Default)]
pub(super) struct Files {
    results: VecDeque<Arc<ResultFile>>,
    snapshots: HashMap<String, (String, TempDir, PathBuf)>,
}

impl Files {
    pub fn result(&self, id: &str) -> Result<Arc<ResultFile>> {
        self.results
            .iter()
            .find(|r| r.dataset.id == id)
            .cloned()
            .context("Query result expired. Run the query again")
    }

    fn sources(&mut self, conn: &Connection) -> Result<Vec<(String, PathBuf)>> {
        let sources = crate::notebooks::sources(conn)?;
        self.snapshots
            .retain(|id, _| sources.iter().any(|(_, d)| &d.id == id));
        let mut paths = vec![];
        for (name, ds) in sources {
            let path = if ds.ephemeral {
                let cache = self.snapshots.get(&ds.id);
                if !cache.is_some_and(|(version, _, _)| version == &ds.imported_at) {
                    let dir = tempfile::tempdir()?;
                    let path = dir.path().join("snapshot.parquet");
                    ledger::export(conn, &ds, &path)?;
                    self.snapshots
                        .insert(ds.id.clone(), (ds.imported_at, dir, path));
                }
                self.snapshots[&ds.id].2.clone()
            } else {
                ds.source_file.into()
            };
            paths.push((name, dunce::canonicalize(path)?));
        }
        Ok(paths)
    }
}

pub(super) fn page(file: &ResultFile, start: u64) -> Result<Value> {
    let conn = Connection::open_in_memory()?;
    let ds = &file.dataset;
    let names = ds
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    let rows = ledger::page(&conn, ds, &Default::default(), &[], &names, start, 100)?;
    let mut bytes = 0;
    let mut output = Vec::new();
    for row in rows {
        let values = row.into_iter().skip(1).collect::<Vec<_>>();
        bytes += serde_json::to_vec(&values)?.len();
        if bytes > 512 * 1024 {
            ensure!(
                !output.is_empty(),
                "One row exceeds the response limit. Select fewer or shorter columns"
            );
            break;
        }
        output.push(values);
    }
    let next = start.saturating_add(output.len() as u64);
    Ok(
        json!({"resultId":ds.id,"columns":ds.columns,"rows":output,"total":ds.row_count,
        "next":(next < ds.row_count as u64).then_some(next),"start":start}),
    )
}

fn path_sql(path: &Path) -> Result<String> {
    Ok(literal(path.to_str().context("Invalid file path")?))
}

pub(super) fn run(core: &Workspace, sql: &str) -> Result<Arc<ResultFile>> {
    ensure!(!sql.trim().is_empty(), "Enter a SQL query");
    let dir = tempfile::tempdir()?;
    let output = dunce::canonicalize(dir.path())?.join("result.parquet");
    let sources = {
        let conn = core
            .engine
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("Workspace unavailable"))?;
        core.files.lock().unwrap().sources(&conn)?
    };
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "SET autoload_known_extensions=false; SET autoinstall_known_extensions=false;
        SET allow_community_extensions=false; SET threads=2; SET memory_limit='1GB';
        SET max_temp_directory_size='2GB'; LOAD parquet; LOAD json",
    )?;
    let mut paths = vec![path_sql(&output)?];
    for (name, path) in sources {
        let path = path.to_str().context("Invalid file path")?;
        paths.push(literal(path));
        let pattern = ledger::parquet_pattern(path);
        if pattern != path {
            // DuckDB checks the literal glob and the resolved file separately.
            paths.push(literal(&pattern));
        }
        let scan = ledger::parquet_scan(path, false);
        conn.execute_batch(&format!(
            "CREATE VIEW {} AS SELECT * FROM {scan}",
            ident(&name)
        ))?;
    }
    conn.execute_batch(&format!(
        "SET allowed_paths=[{}]; SET enable_external_access=false; SET lock_configuration=true",
        paths.join(",")
    ))?;
    let handle = conn.interrupt_handle();
    std::thread::scope(|scope| -> Result<()> {
        let (finish, done) = std::sync::mpsc::channel::<()>();
        let stop = core.stop.clone();
        scope.spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                done.recv_timeout(std::time::Duration::from_millis(100))
            {
                if stop.is_cancelled() || std::time::Instant::now() >= deadline {
                    handle.interrupt();
                }
            }
        });
        let result = conn.execute_batch(&format!(
            "COPY (SELECT * FROM query({})) TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
            literal(sql),
            path_sql(&output)?
        ));
        drop(finish);
        result?;
        Ok(())
    })?;
    core.check_enabled()?;
    let mut dataset = ledger::file_dataset(&conn, &output)?;
    dataset.display_name = "MCP".into();
    let file = Arc::new(ResultFile {
        dataset,
        sql: sql.into(),
        _directory: dir,
    });
    let mut files = core.files.lock().unwrap();
    files.results.push_front(file.clone());
    files.results.truncate(8);
    Ok(file)
}
