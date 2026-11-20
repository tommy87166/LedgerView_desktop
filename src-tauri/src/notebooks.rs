use crate::ledger::{self, ident, literal, Dataset};
use anyhow::{ensure, Context, Result};
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path, time::Instant};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
pub struct Cell {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    slot: Option<usize>,
    name: String,
    sql: String,
}

#[derive(Deserialize, Serialize)]
pub struct Notebook {
    id: String,
    name: String,
    cells: Vec<Cell>,
}

impl Notebook {
    // Older documents implicitly numbered cells by their original positions.
    fn slots(&self) -> impl Iterator<Item = (usize, &Cell)> {
        self.cells
            .iter()
            .enumerate()
            .map(|(index, cell)| (cell.slot.unwrap_or(index), cell))
    }
}

#[derive(Deserialize, Serialize)]
struct FileCell {
    name: String,
    sql: String,
}

#[derive(Deserialize, Serialize)]
struct NotebookFile {
    format: String,
    version: u32,
    name: String,
    cells: Vec<FileCell>,
}

pub fn list(conn: &Connection) -> Result<Vec<Notebook>> {
    let mut stmt = conn.prepare("SELECT document FROM ledger_notebooks ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn get(conn: &Connection, id: &str) -> Result<Notebook> {
    let text: String = conn.query_row(
        "SELECT document FROM ledger_notebooks WHERE id=?",
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&text)?)
}

fn insert(conn: &Connection, name: String, cells: Vec<Cell>) -> Result<Notebook> {
    let book = Notebook {
        id: Uuid::new_v4().to_string(),
        name,
        cells,
    };
    conn.execute(
        "INSERT INTO ledger_notebooks VALUES (?,?)",
        params![book.id, serde_json::to_string(&book)?],
    )?;
    Ok(book)
}

pub fn create(conn: &Connection, cell_name: String) -> Result<Notebook> {
    let books = list(conn)?;
    let name = (1..)
        .map(|n| format!("SQL {n}"))
        .find(|s| books.iter().all(|b| b.name != *s))
        .unwrap();
    insert(
        conn,
        name,
        vec![Cell {
            slot: None,
            name: cell_name,
            sql: String::new(),
        }],
    )
}

pub fn save(conn: &Connection, book: &Notebook) -> Result<()> {
    ensure!(!book.name.trim().is_empty(), "Enter a notebook name");
    let slots: HashSet<_> = book.slots().map(|(slot, _)| slot).collect();
    ensure!(slots.len() == book.cells.len(), "Duplicate SQL cell");
    let tx = conn.unchecked_transaction()?;
    for (slot, _) in get(&tx, &book.id)?.slots() {
        if !slots.contains(&slot) {
            drop_result(&tx, &book.id, slot)?;
        }
    }
    tx.execute(
        "UPDATE ledger_notebooks SET document=? WHERE id=?",
        params![serde_json::to_string(book)?, book.id],
    )?;
    tx.commit()?;
    Ok(())
}

fn distinct_name(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(&base.to_ascii_lowercase()) {
        return base.to_owned();
    }
    (2..)
        .map(|n| format!("{base} ({n})"))
        .find(|s| !taken.contains(&s.to_ascii_lowercase()))
        .unwrap()
}

pub fn open(conn: &Connection, path: &Path) -> Result<Notebook> {
    let text = fs::read_to_string(path)?;
    let doc: NotebookFile = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .context("Invalid LedgerView notebook")?;
    ensure!(
        doc.format == "ledgerview-notebook" && doc.version == 1 && !doc.name.trim().is_empty(),
        "Unsupported LedgerView notebook"
    );
    let names = list(conn)?
        .into_iter()
        .map(|b| b.name.to_ascii_lowercase())
        .collect();
    let cells = doc
        .cells
        .into_iter()
        .map(|cell| Cell {
            slot: None,
            name: cell.name,
            sql: cell.sql,
        })
        .collect();
    insert(conn, distinct_name(doc.name.trim(), &names), cells)
}

pub fn export(conn: &Connection, id: &str, path: &Path) -> Result<()> {
    ensure!(
        path.extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("json")),
        "Choose a .lvnb.json file"
    );
    let book = get(conn, id)?;
    let doc = NotebookFile {
        format: "ledgerview-notebook".into(),
        version: 1,
        name: book.name,
        cells: book
            .cells
            .into_iter()
            .map(|cell| FileCell {
                name: cell.name,
                sql: cell.sql,
            })
            .collect(),
    };
    let tmp = tempfile::NamedTempFile::new_in(path.parent().context("Invalid file path")?)?;
    serde_json::to_writer_pretty(tmp.as_file(), &doc)?;
    tmp.persist(path)?;
    Ok(())
}

fn result_table(id: &str, cell: usize) -> Result<String> {
    Ok(format!(
        "lv_result_{}_{cell}",
        Uuid::parse_str(id)?.simple()
    ))
}

fn drop_result(conn: &Connection, id: &str, slot: usize) -> Result<()> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS temp.main.{}",
        ident(&result_table(id, slot)?)
    ))?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    let book = get(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    for (slot, _) in book.slots() {
        drop_result(&tx, id, slot)?;
    }
    tx.execute("DELETE FROM ledger_notebooks WHERE id=?", [id])?;
    tx.commit()?;
    Ok(())
}

fn sources(conn: &Connection) -> Result<Vec<(String, Dataset)>> {
    let mut stmt = conn.prepare("SELECT dataset, sql_alias FROM ledger_entries ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let mut datasets = Vec::new();
    let mut taken: HashSet<String> = ["ledger_entries".into(), "ledger_notebooks".into()].into();
    for row in rows {
        let (raw, alias) = row?;
        let ds: Dataset = serde_json::from_str(&raw)?;
        taken.insert(ds.table_name.to_ascii_lowercase());
        if let Some(name) = &alias {
            taken.insert(name.to_ascii_lowercase());
        }
        datasets.push((ds, alias));
    }
    let mut available = Vec::new();
    for (ds, alias) in datasets {
        let name = match alias {
            Some(name) => name,
            None => {
                let base = if ds.ephemeral {
                    ds.display_name.as_str()
                } else {
                    Path::new(&ds.display_name)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&ds.display_name)
                };
                let name = distinct_name(base, &taken);
                // Closing one of two identically named files must not retarget saved SQL.
                conn.execute(
                    "UPDATE ledger_entries SET sql_alias=? WHERE id=?",
                    params![name, ds.id],
                )?;
                taken.insert(name.to_ascii_lowercase());
                name
            }
        };
        // Restore may keep the catalog entry for a moved or damaged source.
        // Bind it outside the result transaction so it cannot abort unrelated queries.
        if ds.ephemeral
            || (Path::new(&ds.source_file).is_file()
                && conn
                    .prepare(&format!(
                        "SELECT * EXCLUDE ({}) FROM {} LIMIT 0",
                        ident(&ds.row_key),
                        ds.relation()
                    ))
                    .is_ok())
        {
            available.push((name, ds));
        }
    }
    Ok(available)
}

pub fn source_names(conn: &Connection) -> Result<Vec<String>> {
    Ok(sources(conn)?.into_iter().map(|(name, _)| name).collect())
}

fn result_dataset(conn: &Connection, table: String, name: String) -> Result<Dataset> {
    let mut columns = ledger::describe(conn, &ident(&table))?;
    // Our materialized table always appends its private paging ordinal last.
    let row_key = columns.pop().context("Missing result ordinal")?.name;
    let row_count = conn.query_row(
        &format!("SELECT count(*) FROM {}", ident(&table)),
        [],
        |row| row.get(0),
    )?;
    Ok(Dataset {
        id: table.clone(),
        table_name: table,
        display_name: name,
        source_file: String::new(),
        kind: "table".into(),
        columns,
        row_count,
        row_key,
        imported_at: String::new(),
        ephemeral: true,
    })
}

fn page(conn: &Connection, ds: &Dataset, start: u64) -> Result<Vec<Vec<Option<String>>>> {
    let columns = ds
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    ledger::page(conn, ds, &Default::default(), &[], &columns, start, 100)
}

pub fn result_page(
    conn: &Connection,
    id: &str,
    cell: usize,
    start: u64,
) -> Result<Vec<Vec<Option<String>>>> {
    let ds = result_dataset(conn, result_table(id, cell)?, String::new())?;
    page(conn, &ds, start)
}

pub fn run(conn: &Connection, id: &str, slot: usize, sql: &str, snapshot: bool) -> Result<Value> {
    let book = get(conn, id)?;
    let (_, cell) = book
        .slots()
        .find(|(n, _)| *n == slot)
        .context("Unknown SQL cell")?;
    ensure!(!sql.trim().is_empty(), "Enter a SQL query");
    let started = Instant::now();
    let sources = sources(conn)?;
    let tx = conn.unchecked_transaction()?;
    for (name, ds) in &sources {
        tx.execute_batch(&format!(
            "CREATE TEMP VIEW {} AS SELECT * EXCLUDE ({}) FROM {}",
            ident(name),
            ident(&ds.row_key),
            ds.relation()
        ))?;
    }
    let table = result_table(id, slot)?;
    let key = format!("lv_ordinal_{}", Uuid::new_v4().simple());
    // DuckDB's query() binds exactly one SELECT. Materialize it once, including for snapshots.
    tx.execute_batch(&format!("CREATE OR REPLACE TEMP TABLE {} AS SELECT q.*, row_number() OVER () - 1 AS {} FROM query({}) AS q", ident(&table), ident(&key), literal(sql)))?;
    for (name, _) in &sources {
        tx.execute_batch(&format!("DROP VIEW temp.main.{}", ident(name)))?;
    }
    let name = format!("{} · {}", book.name, cell.name);
    let ds = result_dataset(&tx, table, name.clone())?;
    let rows = page(&tx, &ds, 0)?;
    let snap = if snapshot {
        let used = sources
            .iter()
            .filter(|(_, ds)| ds.ephemeral)
            .map(|(_, ds)| ds.display_name.to_ascii_lowercase())
            .collect();
        let fields = ds.columns.iter().map(|c| c.name.clone()).collect();
        Some(ledger::snapshot_in_transaction(
            &tx,
            &ds,
            Default::default(),
            vec![],
            fields,
            sql.to_owned(),
            Some(distinct_name(&name, &used)),
        )?)
    } else {
        None
    };
    tx.commit()?;
    Ok(
        json!({"columns":ds.columns,"total":ds.row_count,"elapsedMs":started.elapsed().as_millis(),"rows":rows,"snapshot":snap}),
    )
}
