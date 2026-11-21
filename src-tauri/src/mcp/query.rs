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
    bytes: u64,
    _directory: TempDir,
    cache: Arc<cache::Cache>,
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

    // Paged/exported results hold an Arc lease. Their disk space is only
    // available after the final reader releases it.
    fn make_room(&mut self, bytes: u64, total: u64, max_existing: usize) -> Result<()> {
        let mut used: u64 = self.results.iter().map(|f| f.bytes).sum();
        while used.saturating_add(bytes) > total || self.results.len() > max_existing {
            let index = self
                .results
                .iter()
                .rposition(|f| Arc::strong_count(f) == 1)
                .context("Result cache is in use. Try again after the other requests finish")?;
            used -= self.results.remove(index).unwrap().bytes;
        }
        Ok(())
    }

    fn sources(&mut self, conn: &Connection, cache: &Path) -> Result<Vec<(String, PathBuf)>> {
        let sources = crate::notebooks::sources(conn)?;
        self.snapshots
            .retain(|id, _| sources.iter().any(|(_, d)| &d.id == id));
        let mut paths = vec![];
        for (name, ds) in sources {
            let path = if ds.ephemeral {
                let snapshot = self.snapshots.get(&ds.id);
                if !snapshot.is_some_and(|(version, _, _)| version == &ds.imported_at) {
                    let dir = tempfile::tempdir_in(cache)?;
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
    let _access = file.cache.access()?;
    let spill = tempfile::tempdir_in(file._directory.path())?;
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(&format!("SET temp_directory={}", path_sql(spill.path())?))?;
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

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub single: u64,
    pub total: u64,
}
const GIB: u64 = 1024 * 1024 * 1024;
pub(super) const RESULT_LIMITS: Limits = Limits {
    single: 2 * GIB,
    total: 8 * GIB,
};

pub(super) fn interruptible<T>(
    conn: &Connection,
    check: impl Fn() -> Result<()> + Sync,
    work: impl FnOnce() -> Result<T>,
) -> Result<T> {
    check()?;
    let handle = conn.interrupt_handle();
    std::thread::scope(|scope| {
        let (finish, done) = std::sync::mpsc::channel::<()>();
        let poll = &check;
        let monitor = scope.spawn(move || {
            let mut error = None;
            while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                done.recv_timeout(Duration::from_millis(50))
            {
                if error.is_none() {
                    error = poll().err();
                }
                if error.is_some() {
                    handle.interrupt();
                }
            }
            error
        });
        let result = work();
        drop(finish);
        if let Some(err) = monitor.join().expect("query monitor") {
            return Err(err);
        }
        check()?;
        result
    })
}

pub(super) fn run(
    core: &Workspace,
    sql: &str,
    cancel: &CancellationToken,
    limits: Limits,
) -> Result<Arc<ResultFile>> {
    ensure!(!sql.trim().is_empty(), "Enter a SQL query");
    let _access = core.cache.access()?;
    core.check_enabled()?;
    let dir = tempfile::tempdir_in(&core.cache.directory)?;
    let output = dunce::canonicalize(dir.path())?.join("result.parquet");
    let deadline = Instant::now() + Duration::from_secs(60);
    let check = || {
        core.check_request(cancel)?;
        ensure!(Instant::now() < deadline, "Query exceeded 60 seconds");
        Ok(())
    };
    let reader = core.engine.reader()?;
    let sources = interruptible(&reader, check, || {
        let tx = reader.unchecked_transaction()?;
        let sources = core
            .files
            .lock()
            .unwrap()
            .sources(&tx, &core.cache.directory)?;
        tx.commit()?;
        Ok(sources)
    })?;
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "SET autoload_known_extensions=false; SET autoinstall_known_extensions=false;
        SET allow_community_extensions=false; SET threads=2; SET memory_limit='1GB';
        SET max_temp_directory_size='2GB'; LOAD parquet; LOAD json",
    )?;
    conn.execute_batch(&format!(
        "SET temp_directory={}",
        path_sql(&dir.path().join("spill"))?
    ))?;
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
    let check_output = || {
        check()?;
        let bytes = match output.metadata() {
            Ok(meta) => meta.len(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
            Err(err) => return Err(err.into()),
        };
        ensure!(
            bytes <= limits.single,
            "Query result exceeds the {} byte limit",
            limits.single
        );
        core.files.lock().unwrap().make_room(bytes, limits.total, 8)
    };
    let mut dataset = interruptible(&conn, check_output, || {
        conn.execute_batch(&format!(
            "COPY (SELECT * FROM query({})) TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
            literal(sql),
            path_sql(&output)?
        ))?;
        ledger::file_dataset(&conn, &output)
    })?;
    dataset.display_name = "MCP".into();
    let file = Arc::new(ResultFile {
        dataset,
        sql: sql.into(),
        bytes: output.metadata()?.len(),
        _directory: dir,
        cache: core.cache.clone(),
    });
    let mut files = core.files.lock().unwrap();
    check()?;
    files.make_room(file.bytes, limits.total, 7)?;
    files.results.push_front(file.clone());
    Ok(file)
}
