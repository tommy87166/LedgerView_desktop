use crate::bindings;
use crate::filter::{order, predicate, Filters, Sort};
use anyhow::{ensure, Context, Result};
use duckdb::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
pub(crate) fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
fn id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub duckdb_type: String,
    pub display_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dataset {
    pub id: String,
    pub table_name: String,
    pub display_name: String,
    pub source_file: String,
    pub kind: String,
    pub columns: Vec<Column>,
    pub row_count: i64,
    pub row_key: String,
    pub imported_at: String,
    pub ephemeral: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub table_name: String,
    pub display_name: String,
    pub source_table: String,
    pub source_display_name: String,
    pub filter_model: Filters,
    pub sort_model: Vec<Sort>,
    pub filter_desc: String,
    pub row_count: i64,
    pub column_count: usize,
    pub created_at: String,
}

fn parquet_scan(path: &str, row_number: bool) -> String {
    // DuckDB accepts globs even for a single file. Match metacharacters literally.
    let pattern: String = path
        .chars()
        .map(|c| match c {
            '[' => "[[]".into(),
            '*' => "[*]".into(),
            '?' => "[?]".into(),
            _ => c.to_string(),
        })
        .collect();
    format!(
        "read_parquet({}, hive_partitioning=false, file_row_number={row_number})",
        literal(&pattern)
    )
}

impl Dataset {
    pub fn column(&self, name: &str) -> Result<&Column> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .with_context(|| format!("Unknown column {name}"))
    }
    pub(crate) fn relation(&self) -> String {
        if self.ephemeral {
            return ident(&self.table_name);
        }
        // Files may already contain a column named file_row_number.
        let available = !self
            .columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case("file_row_number"));
        let scan = parquet_scan(&self.source_file, available);
        let key = ident(&self.row_key);
        if available {
            format!("(SELECT * EXCLUDE(file_row_number), file_row_number AS {key} FROM {scan}) AS ledger")
        } else {
            format!("(SELECT *, row_number() OVER () - 1 AS {key} FROM {scan}) AS ledger")
        }
    }
}

pub(crate) fn describe(conn: &Connection, relation: &str) -> Result<Vec<Column>> {
    let mut stmt = conn.prepare(&format!("DESCRIBE SELECT * FROM {relation}"))?;
    let rows = stmt.query_map([], |r| {
        let name = r.get(0)?;
        let ty: String = r.get(1)?;
        let display = match ty.as_str() {
            "BOOLEAN" => "boolean",
            "DATE" => "date",
            "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "HUGEINT" | "UTINYINT"
            | "USMALLINT" | "UINTEGER" | "UBIGINT" | "UHUGEINT" | "DOUBLE" | "FLOAT" => "number",
            t if t.starts_with("DECIMAL(") && t.ends_with(')') => "number",
            t if t.starts_with("TIMESTAMP") && !t.contains('[') => "datetime",
            _ => "text",
        };
        Ok(Column {
            name,
            duckdb_type: ty,
            display_type: display.into(),
        })
    })?;
    Ok(rows.collect::<duckdb::Result<_>>()?)
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;
        LOAD parquet; LOAD json; SET threads=4; SET memory_limit='2GB'; SET max_temp_directory_size='8GB';
        CREATE TABLE IF NOT EXISTS ledger_entries (id VARCHAR PRIMARY KEY, dataset VARCHAR NOT NULL, snapshot VARCHAR);
        ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS sql_alias VARCHAR;
        CREATE TABLE IF NOT EXISTS ledger_notebooks (id VARCHAR PRIMARY KEY, document VARCHAR NOT NULL)")?;
    Ok(())
}

fn refresh(conn: &Connection, ds: &mut Dataset) -> Result<()> {
    let scan = parquet_scan(&ds.source_file, false);
    ds.columns = describe(conn, &scan)?;
    ds.row_key = "__rownum__".into();
    while ds
        .columns
        .iter()
        .any(|c| c.name.eq_ignore_ascii_case(&ds.row_key))
    {
        ds.row_key.push('_');
    }
    ds.row_count = conn.query_row(&format!("SELECT count(*) FROM {scan}"), [], |r| r.get(0))?;
    Ok(())
}

pub fn open(conn: &Connection, path: &Path) -> Result<Dataset> {
    ensure!(
        path.extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("parquet")),
        "Select a .parquet file"
    );
    let path = dunce::canonicalize(path)?;
    ensure!(path.is_file(), "Expected a local file");
    let source_file = path.to_str().context("Invalid file path")?.to_owned();
    let table_name = id("data");
    let mut ds = Dataset {
        id: table_name.clone(),
        table_name,
        display_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        source_file,
        kind: "view".into(),
        columns: vec![],
        row_count: 0,
        row_key: String::new(),
        imported_at: now(),
        ephemeral: false,
    };
    refresh(conn, &mut ds)?;
    bindings::execute(
        conn,
        "INSERT INTO ledger_entries (id, dataset, snapshot) VALUES (?, ?, NULL)",
        &[ds.id.as_str(), &serde_json::to_string(&ds)?],
    )?;
    Ok(ds)
}

pub fn dataset(conn: &Connection, id: &str) -> Result<Dataset> {
    let json: String = bindings::query_row(
        conn,
        "SELECT dataset FROM ledger_entries WHERE id=?",
        &[id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&json)?)
}

#[derive(Serialize)]
pub struct Catalog {
    datasets: Vec<Dataset>,
    snapshots: Vec<Snapshot>,
    failed: Vec<String>,
}

pub fn restore(conn: &Connection) -> Result<Catalog> {
    let mut stmt = conn.prepare("SELECT dataset, snapshot FROM ledger_entries ORDER BY rowid")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .collect::<duckdb::Result<Vec<_>>>()?;
    let mut state = Catalog {
        datasets: vec![],
        snapshots: vec![],
        failed: vec![],
    };
    for (json, snapshot) in rows {
        if let Some(s) = snapshot {
            state.snapshots.push(serde_json::from_str(&s)?);
            continue;
        }
        let mut ds: Dataset = serde_json::from_str(&json)?;
        if refresh(conn, &mut ds).is_err() {
            state.failed.push(ds.source_file);
            continue;
        }
        bindings::execute(
            conn,
            "UPDATE ledger_entries SET dataset=? WHERE id=?",
            &[&serde_json::to_string(&ds)?, &ds.id],
        )?;
        state.datasets.push(ds);
    }
    state.snapshots.reverse();
    Ok(state)
}

pub fn count(conn: &Connection, ds: &Dataset, filters: &Filters) -> Result<i64> {
    let p = predicate(ds, filters)?;
    let sql = format!("SELECT count(*) FROM {}{}", ds.relation(), p.sql);
    Ok(bindings::query_row(conn, &sql, &p.params, |r| r.get(0))?)
}

fn display_expr(c: &Column) -> String {
    let col = ident(&c.name);
    if c.display_type == "datetime" {
        format!("strftime({col}::TIMESTAMP, '%Y-%m-%d %H:%M:%S')")
    } else {
        format!("CAST({col} AS VARCHAR)")
    }
}

fn values(
    conn: &Connection,
    sql: &str,
    args: &[String],
    width: usize,
) -> Result<Vec<Vec<Option<String>>>> {
    let rows = bindings::query_rows(conn, sql, args, |r| (0..width).map(|i| r.get(i)).collect())?;
    Ok(rows)
}

pub fn page(
    conn: &Connection,
    ds: &Dataset,
    filters: &Filters,
    sort: &[Sort],
    columns: &[String],
    start: u64,
    limit: u32,
) -> Result<Vec<Vec<Option<String>>>> {
    ensure!(limit <= 1000, "Page too large");
    let p = predicate(ds, filters)?;
    let mut select = vec![format!("{}::VARCHAR", ident(&ds.row_key))];
    for c in columns {
        select.push(display_expr(ds.column(c)?));
    }
    let sql = format!(
        "SELECT {} FROM {}{}{} LIMIT {limit} OFFSET {start}",
        select.join(", "),
        ds.relation(),
        p.sql,
        order(ds, sort)?
    );
    values(conn, &sql, &p.params, select.len())
}

pub fn distinct(
    conn: &Connection,
    ds: &Dataset,
    filters: &Filters,
    column: &str,
    limited: bool,
) -> Result<Vec<Option<String>>> {
    let p = predicate(ds, filters)?;
    let col = ident(&ds.column(column)?.name);
    let limit = if limited { " LIMIT 1001" } else { "" };
    let sql = format!(
        "SELECT DISTINCT {col}::VARCHAR FROM {}{} ORDER BY 1{limit}",
        ds.relation(),
        p.sql
    );
    Ok(bindings::query_rows(conn, &sql, &p.params, |r| r.get(0))?)
}

#[derive(Serialize)]
pub struct Aggregate {
    pub sum: Option<String>,
    pub avg: Option<String>,
    pub count: i64,
}

pub fn aggregate(
    conn: &Connection,
    ds: &Dataset,
    filters: &Filters,
    column: &str,
) -> Result<Aggregate> {
    let c = ds.column(column)?;
    ensure!(c.display_type == "number", "Select a numeric column");
    let p = predicate(ds, filters)?;
    let col = ident(column);
    let sql = format!(
        "SELECT sum({col})::VARCHAR, avg({col})::VARCHAR, count({col}) FROM {}{}",
        ds.relation(),
        p.sql
    );
    Ok(bindings::query_row(conn, &sql, &p.params, |r| {
        Ok(Aggregate {
            sum: r.get(0)?,
            avg: r.get(1)?,
            count: r.get(2)?,
        })
    })?)
}

pub fn create_snapshot(
    conn: &Connection,
    ds: &Dataset,
    filters: Filters,
    sort: Vec<Sort>,
    columns: Vec<String>,
    description: String,
) -> Result<Snapshot> {
    let tx = conn.unchecked_transaction()?;
    let snapshot = snapshot_in_transaction(&tx, ds, filters, sort, columns, description, None)?;
    tx.commit()?;
    Ok(snapshot)
}

pub(crate) fn snapshot_in_transaction(
    tx: &duckdb::Transaction<'_>,
    ds: &Dataset,
    filters: Filters,
    sort: Vec<Sort>,
    columns: Vec<String>,
    description: String,
    name: Option<String>,
) -> Result<Snapshot> {
    ensure!(!columns.is_empty(), "Select at least one visible column");
    let projected = columns
        .iter()
        .map(|c| ds.column(c).cloned())
        .collect::<Result<Vec<_>>>()?;
    let table = id("snap");
    let name = name.unwrap_or_else(|| format!("{}_{}", ds.display_name, &table[5..11]));
    let p = predicate(ds, &filters)?;
    let fields = columns
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    // Assign preview ordinals after sorting. This also handles an actual data column named rowid.
    let sql = format!("CREATE TABLE {} AS SELECT *, row_number() OVER () - 1 AS {} FROM (SELECT {fields} FROM {}{}{})",
        ident(&table), ident(&ds.row_key), ds.relation(), p.sql, order(ds, &sort)?);
    bindings::execute(tx, &sql, &p.params)?;
    let row_count = tx.query_row(
        &format!("SELECT count(*) FROM {}", ident(&table)),
        [],
        |r| r.get(0),
    )?;
    let snap = Snapshot {
        id: table.clone(),
        table_name: table.clone(),
        display_name: name.clone(),
        source_table: ds.table_name.clone(),
        source_display_name: ds.display_name.clone(),
        filter_model: filters,
        sort_model: sort,
        filter_desc: description,
        row_count,
        column_count: columns.len(),
        created_at: now(),
    };
    let preview = Dataset {
        id: table.clone(),
        table_name: table.clone(),
        display_name: name,
        source_file: ds.display_name.clone(),
        kind: "table".into(),
        columns: projected,
        row_count,
        row_key: ds.row_key.clone(),
        imported_at: snap.created_at.clone(),
        ephemeral: true,
    };
    bindings::execute(
        tx,
        "INSERT INTO ledger_entries (id, dataset, snapshot) VALUES (?,?,?)",
        &[
            &table,
            &serde_json::to_string(&preview)?,
            &serde_json::to_string(&snap)?,
        ],
    )?;
    Ok(snap)
}

pub fn rename(conn: &Connection, ds: &mut Dataset, name: String) -> Result<()> {
    ensure!(
        ds.ephemeral && !name.trim().is_empty(),
        "Invalid snapshot name"
    );
    let raw: String = bindings::query_row(
        conn,
        "SELECT snapshot FROM ledger_entries WHERE id=?",
        &[&ds.id],
        |r| r.get(0),
    )?;
    let mut snap: Snapshot = serde_json::from_str(&raw)?;
    snap.display_name = name.trim().into();
    ds.display_name = snap.display_name.clone();
    bindings::execute(
        conn,
        "UPDATE ledger_entries SET dataset=?, snapshot=?, sql_alias=NULL WHERE id=?",
        &[
            &serde_json::to_string(ds)?,
            &serde_json::to_string(&snap)?,
            &ds.id,
        ],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, ds: &Dataset) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    if ds.ephemeral {
        tx.execute_batch(&format!("DROP TABLE {}", ident(&ds.table_name)))?;
    }
    bindings::execute(&tx, "DELETE FROM ledger_entries WHERE id=?", &[&ds.id])?;
    tx.commit()?;
    Ok(())
}

pub fn export(conn: &Connection, ds: &Dataset, path: &Path) -> Result<()> {
    ensure!(ds.ephemeral, "Select a snapshot");
    ensure!(
        path.extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("parquet")),
        "Choose a .parquet destination"
    );
    if path.exists() {
        let dest = dunce::canonicalize(path)?;
        let mut stmt = conn.prepare("SELECT dataset FROM ledger_entries WHERE snapshot IS NULL")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let src: Dataset = serde_json::from_str(&row?)?;
            ensure!(
                Path::new(&src.source_file) != dest,
                "The destination is an open source file"
            );
        }
    }
    let tmp = tempfile::NamedTempFile::new_in(path.parent().context("Invalid destination")?)?;
    let fields = ds
        .columns
        .iter()
        .map(|c| ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "COPY (SELECT {fields} FROM {}) TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
        ds.relation(),
        literal(tmp.path().to_str().context("Invalid path")?)
    ))?;
    tmp.persist(path)?;
    Ok(())
}

pub fn clipboard(conn: &Connection, ds: &Dataset) -> Result<String> {
    ensure!(
        ds.ephemeral && ds.row_count.saturating_mul(ds.columns.len() as i64) <= 2_000_000,
        "Snapshot too large to copy"
    );
    fn cell(s: &str) -> String {
        if s.contains(['\t', '\r', '\n', '"']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.into()
        }
    }
    let mut output = ds
        .columns
        .iter()
        .map(|c| cell(&c.name))
        .collect::<Vec<_>>()
        .join("\t");
    let select = ds
        .columns
        .iter()
        .map(|c| format!("{}::VARCHAR", ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {select} FROM {}", ds.relation()))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        output.push('\n');
        for i in 0..ds.columns.len() {
            if i > 0 {
                output.push('\t');
            }
            if let Some(v) = row.get::<_, Option<String>>(i)? {
                output.push_str(&cell(&v));
            }
        }
    }
    Ok(output)
}
