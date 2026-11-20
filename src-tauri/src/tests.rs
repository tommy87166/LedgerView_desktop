use super::*;
use std::path::Path;
use tempfile::{tempdir, TempDir};

fn write_file(path: &Path, query: &str) -> Result<()> {
    let conn = Connection::open_in_memory()?;
    let dst = path.to_str().unwrap().replace('\'', "''");
    conn.execute_batch(&format!("COPY ({query}) TO '{dst}' (FORMAT PARQUET)"))?;
    Ok(())
}

struct Session {
    engine: Engine,
    // Close DuckDB before TempDir tries to remove the workspace on Windows.
    dir: TempDir,
}
impl Session {
    fn new() -> Result<Self> {
        let dir = tempdir()?;
        let engine = Engine::new(dir.path().join("state"))?;
        Ok(Self { dir, engine })
    }
    fn send(&self, req: Value) -> Result<Value> {
        self.engine
            .execute(serde_json::from_value(req)?, "test".into(), false, None)
    }
    fn file(&self, name: &str, query: &str) -> Result<Value> {
        let path = self.dir.path().join(name);
        write_file(&path, query)?;
        self.send(json!({"type":"open","path":path}))
    }
    fn page(&self, id: &Value, filters: Value, sort: Value, columns: Value) -> Result<Value> {
        self.send(json!({"type":"page","id":id,"filters":filters,"sort":sort,"columns":columns,"start":0,"limit":200}))
    }
    fn count(&self, id: &Value, filters: Value) -> Result<Value> {
        self.send(json!({"type":"count","id":id,"filters":filters}))
    }
}

#[test]
fn bundled_duckdb_version() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    let version: String = conn.query_row("SELECT version()", [], |row| row.get(0))?;
    assert_eq!(version, "v2.0.0");
    Ok(())
}

#[test]
fn unavailable_workspace_runs_in_memory_and_loses_changes_on_restart() -> Result<()> {
    let tmp = tempdir()?;
    let blocked = tmp.path().join("ordinary-file");
    fs::write(&blocked, b"existing file")?;
    let directory = blocked.join("workspace");
    let session = Session {
        engine: Engine::new(directory.clone())?,
        dir: tmp,
    };
    let book = session.send(json!({"type":"createNotebook","cellName":"SQL"}))?;
    let restored = session.send(json!({"type":"restore"}))?;
    assert_eq!(restored["persistent"], false);
    assert_eq!(restored["notebooks"][0]["id"], book["id"]);
    drop(session.engine);
    let reopened = Engine::new(directory)?;
    let fresh = reopened.execute(Request::Restore, "restart".into(), false, None)?;
    assert_eq!(fresh["notebooks"], json!([]));
    assert_eq!(fs::read(blocked)?, b"existing file");
    Ok(())
}

#[test]
fn corrupt_existing_catalog_reports_an_error_and_preserves_the_file() -> Result<()> {
    let dir = tempdir()?;
    let catalog = dir.path().join("ledger.duckdb");
    let original = b"This is not a DuckDB catalog";
    fs::write(&catalog, original)?;
    let error = Engine::new(dir.path().to_owned())
        .err()
        .expect("corrupt catalog must fail to open");
    assert!(error.to_string().contains("Opening LedgerView catalog"));
    assert_eq!(fs::read(catalog)?, original);
    Ok(())
}

#[test]
fn voucher_to_snapshot_to_parquet_after_restart() -> Result<()> {
    let mut s = Session::new()?;
    let subset = s.file("科目.parquet", "SELECT * FROM (VALUES ('V-01','Bank'),('V-01','Bank'),('V-02','Cash'),(NULL,'Bank')) t(v,account)")?;
    let full = s.file("完整分錄.parquet", "SELECT * FROM (VALUES ('V-01', 9007199254740993.1234::DECIMAL(26,4), 'Bank'),('V-01', -0.1200, 'Tax'),('V-01',NULL,'Cash'),('V-02',8,'Other')) t(v,amount,account)")?;
    let vals = s.send(json!({"type":"distinct","id":subset["id"],"column":"v","filters":{"account":{"filterType":"text","type":"equals","filter":"bank"}},"limited":false}))?;
    assert_eq!(vals, json!(["V-01", null]));
    let filter = json!({"v":{"filterType":"set","values":["V-01"],"includeBlanks":false}});
    let sort = json!([{"colId":"amount","sort":"desc"}]);
    let cols = json!(["v", "account"]);
    assert_eq!(s.count(&full["id"], filter.clone())?, 3);
    let agg =
        s.send(json!({"type":"aggregate","id":full["id"],"filters":filter,"column":"amount"}))?;
    assert_eq!(agg["sum"], "9007199254740993.0034");
    assert_eq!(agg["count"], 2);
    let snap = s.send(json!({"type":"snapshot","id":full["id"],"filters":filter,"sort":sort,"columns":cols,"description":"v ∈ V-01"}))?;
    assert_eq!(snap["rowCount"], 3);
    s.send(json!({"type":"rename","id":snap["id"],"name":"Voucher review"}))?;
    s.send(json!({"type":"remove","id":full["id"]}))?;
    assert!(s.dir.path().join("完整分錄.parquet").is_file());
    fs::remove_file(s.dir.path().join("完整分錄.parquet"))?;
    let directory = s.engine.directory.clone();
    drop(s.engine);
    s.engine = Engine::new(directory)?;
    let restored = s.send(json!({"type":"restore"}))?;
    assert_eq!(
        restored["catalog"]["snapshots"][0]["displayName"],
        "Voucher review"
    );
    assert_eq!(restored["catalog"]["datasets"][0]["id"], subset["id"]);
    let expected = json!([
        ["0", "V-01", "Bank"],
        ["1", "V-01", "Tax"],
        ["2", "V-01", "Cash"]
    ]);
    assert_eq!(
        s.page(&snap["id"], json!({}), json!([]), cols.clone())?,
        expected
    );
    assert_eq!(
        s.send(json!({"type":"clipboard","id":snap["id"]}))?,
        "v\taccount\nV-01\tBank\nV-01\tTax\nV-01\tCash"
    );
    let child = s.send(json!({"type":"snapshot","id":snap["id"],"filters":{"account":{"filterType":"text","type":"equals","filter":"tax"}},"sort":[],"columns":["account"],"description":"Tax"}))?;
    let output = s.dir.path().join("交付.parquet");
    s.send(json!({"type":"export","id":snap["id"],"path":output}))?;
    let exported = s.send(json!({"type":"open","path":output}))?;
    assert_eq!(exported["columns"].as_array().unwrap().len(), 2);
    assert_eq!(
        s.page(&exported["id"], json!({}), json!([]), cols)?,
        expected
    );
    assert!(s
        .send(json!({"type":"export","id":snap["id"],"path":output}))
        .is_err());
    s.send(json!({"type":"remove","id":snap["id"]}))?;
    assert_eq!(
        s.page(&child["id"], json!({}), json!([]), json!(["account"]))?,
        json!([["0", "Tax"]])
    );
    Ok(())
}

#[test]
fn filter_operators_keep_source_ordinals_and_precision() -> Result<()> {
    let s = Session::new()?;
    let ds = s.file("audit.parquet", "SELECT * FROM (VALUES ('A_1',9007199254740993::BIGINT, TIMESTAMP '2026-01-01 23:59:59', true), ('A%2',9007199254740994,TIMESTAMP '2026-01-02', false),('',0,TIMESTAMP '2026-01-03',NULL),(NULL,NULL,NULL,NULL)) t(v,n,d,b)")?;
    let id = &ds["id"];
    for (op, value, n) in [
        ("contains", "_", 1),
        ("notContains", "%", 3),
        ("startsWith", "a", 2),
        ("endsWith", "2", 1),
        ("equals", "a_1", 1),
        ("notEqual", "a_1", 3),
        ("blank", "", 2),
        ("notBlank", "", 2),
    ] {
        assert_eq!(
            s.count(
                id,
                json!({"v":{"filterType":"text","type":op,"filter":value}})
            )?,
            n,
            "{op}"
        );
    }
    for (op, value, other, n) in [
        ("equals", "9007199254740993", "", 1),
        ("notEqual", "0", "", 3),
        ("equals", "9.007199254740993e15", "", 1),
        ("greaterThan", "9007199254740993", "", 1),
        ("greaterThanOrEqual", "9007199254740993", "", 2),
        ("lessThan", ".5", "", 1),
        ("lessThanOrEqual", "0", "", 1),
        ("inRange", "0", "9007199254740993", 2),
        ("blank", "", "", 1),
        ("notBlank", "", "", 3),
    ] {
        assert_eq!(
            s.count(
                id,
                json!({"n":{"filterType":"number","type":op,"filter":value,"filterTo":other}})
            )?,
            n,
            "{op}"
        );
    }
    for (op, n) in [
        ("equals", 1),
        ("notEqual", 3),
        ("greaterThan", 2),
        ("lessThan", 0),
        ("inRange", 2),
        ("blank", 1),
        ("notBlank", 3),
    ] {
        assert_eq!(s.count(id,json!({"d":{"filterType":"date","type":op,"dateFrom":"2026-01-01 00:00:00","dateTo":"2026-01-02"}}))?,n,"{op}");
    }
    for (join, n) in [("OR", 2), ("AND", 0)] {
        assert_eq!(s.count(id,json!({"v":{"filterType":"text","operator":join,"conditions":[{"filterType":"text","type":"equals","filter":"A_1"},{"filterType":"text","type":"equals","filter":"A%2"}]}}))?,n);
    }
    assert_eq!(
        s.count(
            id,
            json!({"b":{"filterType":"set","values":["false"],"includeBlanks":true}})
        )?,
        3
    );
    assert_eq!(
        s.count(
            id,
            json!({"v":{"filterType":"set","values":[],"includeBlanks":false}})
        )?,
        0
    );
    let rows = s.page(
        id,
        json!({"b":{"filterType":"set","values":["true","false"]}}),
        json!([{"colId":"d","sort":"desc"}]),
        json!(["n", "d"]),
    )?;
    assert_eq!(
        rows,
        json!([
            ["1", "9007199254740994", "2026-01-02 00:00:00"],
            ["0", "9007199254740993", "2026-01-01 23:59:59"]
        ])
    );
    assert!(s
        .count(id, json!({"unknown":{"filterType":"text","type":"blank"}}))
        .is_err());
    Ok(())
}

#[test]
fn special_filenames_and_headers_are_literal() -> Result<()> {
    let s = Session::new()?;
    write_file(&s.dir.path().join("a.parquet"), "SELECT 0 AS unwanted")?;
    let ds = s.file(
        "[a].parquet",
        "SELECT 'ok' AS file_row_number, 'data' AS __rownum__, 3 AS rowid, '中文' AS \"a.b\"",
    )?;
    assert_ne!(ds["rowKey"], "__rownum__");
    assert_eq!(
        s.page(
            &ds["id"],
            json!({}),
            json!([]),
            json!(["file_row_number", "__rownum__", "rowid", "a.b"])
        )?,
        json!([["0", "ok", "data", "3", "中文"]])
    );
    let quoted = s.file("sample'範例.parquet", "SELECT 7 AS \"e\"\"x\"")?;
    assert_eq!(
        s.page(&quoted["id"], json!({}), json!([]), json!(["e\"x"]))?,
        json!([["0", "7"]])
    );
    Ok(())
}

#[test]
fn large_paging_distinct_and_full_array_filter() -> Result<()> {
    let s = Session::new()?;
    let ds = s.file(
        "range.parquet",
        "SELECT i, 'V'||(i%3000) v FROM range(2000000) t(i)",
    )?;
    assert_eq!(ds["rowCount"], 2_000_000);
    let values = |limited| {
        s.send(json!({"type":"distinct","id":ds["id"],"column":"v","filters":{},"limited":limited}))
    };
    assert_eq!(values(true)?.as_array().unwrap().len(), 1001);
    let all = values(false)?;
    assert_eq!(all.as_array().unwrap().len(), 3000);
    assert_eq!(
        s.count(&ds["id"], json!({"v":{"filterType":"set","values":all}}))?,
        2_000_000
    );
    let rows = s.send(json!({"type":"page","id":ds["id"],"filters":{},"sort":[{"colId":"i","sort":"desc"}],"columns":["i"],"start":1999998,"limit":200}))?;
    assert_eq!(rows, json!([["1", "1"], ["0", "0"]]));
    Ok(())
}

#[test]
fn invalid_file_does_not_break_catalog_or_other_sources() -> Result<()> {
    let s = Session::new()?;
    let one = s.file("one.parquet", "SELECT 1 AS n")?;
    let missing = s.file("missing.parquet", "SELECT 1 AS n")?;
    fs::remove_file(missing["sourceFile"].as_str().unwrap())?;
    let bad = s.dir.path().join("broken.parquet");
    fs::write(&bad, b"bad")?;
    assert!(s.send(json!({"type":"open","path":bad})).is_err());
    let catalog = s.send(json!({"type":"restore"}))?;
    assert_eq!(catalog["catalog"]["datasets"][0]["id"], one["id"]);
    assert_eq!(catalog["catalog"]["failed"], json!([missing["sourceFile"]]));
    assert!(s.send(json!({"type":"snapshot","id":one["id"],"columns":[],"filters":{},"sort":[],"description":""})).is_err());
    assert!(catalog["catalog"]["snapshots"]
        .as_array()
        .unwrap()
        .is_empty());
    Ok(())
}

#[test]
fn console_trace_reports_sql_and_can_be_disabled() -> Result<()> {
    let s = Session::new()?;
    let ds = s.file("trace.parquet", "SELECT 42 AS n")?;
    let command = || Request::Count {
        id: ds["id"].as_str().unwrap().into(),
        filters: Filters::new(),
    };
    let report = s.engine.execute(command(), "trace".into(), true, None)?;
    assert_eq!(report["result"], 1);
    assert!(report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["sql"].as_str().unwrap().contains("count(*)")));
    assert_eq!(s.engine.execute(command(), "plain".into(), false, None)?, 1);
    Ok(())
}

#[test]
fn diagnostic_parameters_match_each_filter_and_catalog_lookup() -> Result<()> {
    let s = Session::new()?;
    let ds = s.file(
        "parameters.parquet",
        "SELECT 'Demo''Item?' AS SAMPLE_LABEL, 42 AS amount",
    )?;
    let request = serde_json::from_value(json!({
        "type":"count", "id":ds["id"], "filters":{
            "SAMPLE_LABEL":{"filterType":"text","type":"equals","filter":"demo'item?"},
            "amount":{"filterType":"number","type":"inRange","filter":40,"filterTo":50}
        }
    }))?;
    let report = s.engine.execute(request, "parameters".into(), true, None)?;
    assert_eq!(report["result"], 1);
    let mut saw = (false, false);
    for statement in report["queries"].as_array().unwrap() {
        let sql = statement["sql"].as_str().unwrap();
        assert!(!sql.contains("/*lv_bind_"));
        if sql.contains("ledger_entries WHERE id=?") {
            assert_eq!(statement["params"], json!([ds["id"]]));
            saw.0 = true;
        } else if sql.contains("lower(?)") {
            assert_eq!(statement["params"], json!(["demo'item?", "40", "50"]));
            saw.1 = true;
        }
    }
    assert_eq!(saw, (true, true));
    Ok(())
}

#[test]
fn identical_prepared_sql_keeps_values_from_each_execution() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    let trace = BindingTrace::new();
    let sql = "SELECT ? || '?'";
    conn.execute_batch("CALL enable_logging('QueryLog', storage='memory')")?;
    trace.capture(|| -> Result<()> {
        for value in ["first", "", "last?"] {
            let result: String = bindings::query_row(&conn, sql, &[value], |r| r.get(0))?;
            assert_eq!(result, format!("{value}?"));
        }
        Ok(())
    })?;
    conn.execute_batch("CALL disable_logging()")?;
    let mut stmt =
        conn.prepare("SELECT message FROM duckdb_logs WHERE type='QueryLog' ORDER BY timestamp")?;
    let mut values = Vec::new();
    for msg in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let statement = trace.resolve(msg?);
        if statement.sql == sql {
            values.push(statement.params);
        }
    }
    values.dedup(); // prepare and execute may both be logged
    assert_eq!(values, vec![vec!["first"], vec![""], vec!["last?"]]);
    Ok(())
}

#[test]
fn live_diagnostics_stream_the_worker_sql_and_report_its_error() -> Result<()> {
    let s = Session::new()?;
    let book = s.send(json!({"type":"createNotebook","cellName":"Query"}))?;
    let run = Request::RunNotebook {
        id: book["id"].as_str().unwrap().into(),
        cell: 0,
        sql: "SELECT sum(sin(i)) FROM range(150000000) t(i)".into(),
        snapshot: false,
    };
    let notify = |statement: LoggedStatement| {
        if statement.sql.contains("sum(sin(i))") {
            // Receiving this statement before dispatch finishes allows us to interrupt it.
            if let Some((_, handle)) = s.engine.active.lock().unwrap().as_ref() {
                handle.interrupt();
            }
        }
    };
    let report = s.engine.execute(run, "live".into(), true, Some(&notify))?;
    assert!(report["error"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .contains("interrupt"));
    assert!(report["elapsedMs"].as_f64().unwrap() > 0.0);
    let sql = report["queries"].as_array().unwrap();
    assert!(sql
        .iter()
        .any(|q| q["sql"].as_str().unwrap().contains("sum(sin(i))")));
    assert!(sql
        .iter()
        .all(|q| !q["sql"].as_str().unwrap().contains("FROM duckdb_logs")));
    Ok(())
}

#[test]
fn exported_snapshot_preserves_native_types_nulls_and_projected_order() -> Result<()> {
    let s = Session::new()?;
    let ds = s.file("types.parquet", "SELECT 18446744073709551615::UBIGINT AS id, 123456789012345678.123456::DECIMAL(24,6) AS debit, TIMESTAMP '2026-02-03 04:05:06.789' AS posted, NULL::VARCHAR AS memo")?;
    let columns = json!(["posted", "debit", "memo", "id"]);
    let snap = s.send(json!({"type":"snapshot","id":ds["id"],"filters":{},"sort":[],"columns":columns,"description":""}))?;
    let output = s.dir.path().join("typed.parquet");
    s.send(json!({"type":"export","id":snap["id"],"path":output}))?;
    let copy = s.send(json!({"type":"open","path":output}))?;
    let types: Vec<_> = copy["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (&c["name"], &c["duckdbType"]))
        .collect();
    assert_eq!(
        json!(types),
        json!([
            ["posted", "TIMESTAMP"],
            ["debit", "DECIMAL(24,6)"],
            ["memo", "VARCHAR"],
            ["id", "UBIGINT"]
        ])
    );
    assert_eq!(
        s.page(&copy["id"], json!({}), json!([]), columns)?,
        json!([[
            "0",
            "2026-02-03 04:05:06",
            "123456789012345678.123456",
            null,
            "18446744073709551615"
        ]])
    );
    assert_eq!(s.send(json!({"type":"clipboard","id":snap["id"]}))?, "posted\tdebit\tmemo\tid\n2026-02-03 04:05:06.789\t123456789012345678.123456\t\t18446744073709551615");
    Ok(())
}

#[test]
fn notebook_file_roundtrip_and_restart() -> Result<()> {
    let mut s = Session::new()?;
    let mut book = s.send(json!({"type":"createNotebook","cellName":"查詢 1"}))?;
    book["name"] = json!("旅費核對");
    book["cells"] =
        json!([{"name":"單號","sql":"SELECT 1;"},{"name":"合計","sql":"SELECT '台北';"}]);
    s.send(json!({"type":"saveNotebook","book":book}))?;
    let path = s.dir.path().join("review.lvnb.json");
    s.send(json!({"type":"exportNotebook","id":book["id"],"path":path}))?;
    let file: Value = serde_json::from_slice(&fs::read(&path)?)?;
    assert_eq!(file["format"], "ledgerview-notebook");
    assert_eq!(file["cells"], book["cells"]);
    assert!(file.get("id").is_none());
    let copy = s.send(json!({"type":"openNotebook","path":path}))?;
    assert_ne!(copy["id"], book["id"]);
    assert_eq!(copy["name"], "旅費核對 (2)");
    assert_eq!(copy["cells"], book["cells"]);
    s.send(json!({"type":"deleteNotebook","id":copy["id"]}))?;
    fs::write(
        &path,
        r#"{"format":"ledgerview-notebook","version":2,"name":"test","cells":[]}"#,
    )?;
    assert!(s.send(json!({"type":"openNotebook","path":path})).is_err());
    let dir = s.dir.path().join("state");
    drop(s.engine);
    s.engine = Engine::new(dir)?;
    assert_eq!(
        s.send(json!({"type":"restore"}))?["notebooks"],
        json!([book])
    );
    Ok(())
}

#[test]
fn notebook_query_snapshot_paging_and_failure_rollback() -> Result<()> {
    let s = Session::new()?;
    s.file("總帳.parquet", "SELECT range AS n FROM range(205)")?;
    let book = s.send(json!({"type":"createNotebook","cellName":"查詢 1"}))?;
    let id = &book["id"];
    let run = |sql: &str, snapshot: bool| {
        s.send(json!({"type":"runNotebook","id":id,"cell":0,"sql":sql,"snapshot":snapshot}))
    };
    let words = s.send(json!({"type":"sqlVocabulary"}))?;
    for (group, word) in [
        ("keywords", "qualify"),
        ("functions", "list_transform"),
        ("tableFunctions", "read_parquet"),
        ("types", "hugeint"),
    ] {
        assert!(words[group].as_array().unwrap().contains(&json!(word)));
    }
    let result = run(
        r#"SELECT n, uuid() AS token FROM "總帳" ORDER BY n DESC;"#,
        true,
    )?;
    assert_eq!(result["total"], 205);
    assert_eq!(result["rows"].as_array().unwrap().len(), 100);
    assert_eq!(result["rows"][0][1], "204");
    let snapshot = &result["snapshot"];
    assert_eq!(snapshot["displayName"], "SQL 1 · 查詢 1");
    assert_eq!(
        s.send(json!({"type":"notebookSources"}))?,
        json!([
            {"name":"總帳", "isSnapshot":false, "columns":[result["columns"][0]]},
            {"name":snapshot["displayName"], "isSnapshot":true, "columns":result["columns"]}
        ])
    );
    let persisted = s.page(&snapshot["id"], json!({}), json!([]), json!(["n", "token"]))?;
    assert_eq!(persisted[0], result["rows"][0]); // volatile expressions were evaluated once
    let last = s.send(json!({"type":"notebookPage","id":id,"cell":0,"start":200}))?;
    assert_eq!(last.as_array().unwrap().len(), 5);
    assert_eq!(last[4][1], "0");
    assert!(run("SELECT 1; DROP TABLE ledger_entries", false).is_err());
    assert!(run("DELETE FROM ledger_entries", false).is_err());
    assert_eq!(
        s.send(json!({"type":"notebookPage","id":id,"cell":0,"start":200}))?,
        last
    );
    let empty = run(r#"SELECT * FROM "SQL 1 · 查詢 1" WHERE false"#, true)?;
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["columns"].as_array().unwrap().len(), 2);
    assert_eq!(empty["snapshot"]["displayName"], "SQL 1 · 查詢 1 (2)");
    s.send(json!({"type":"deleteNotebook","id":id}))?;
    assert!(s
        .send(json!({"type":"notebookPage","id":id,"cell":0,"start":0}))
        .is_err());
    assert_eq!(s.count(&snapshot["id"], json!({}))?, 205);
    Ok(())
}

#[test]
fn notebook_aliases_survive_missing_and_closed_duplicate_sources() -> Result<()> {
    let s = Session::new()?;
    let first = s.file("科目.parquet", "SELECT 1 AS n")?;
    let nested = s.dir.path().join("other");
    fs::create_dir(&nested)?;
    let path = nested.join("科目.parquet");
    write_file(&path, "SELECT 2 AS n")?;
    s.send(json!({"type":"open","path":path}))?;
    assert_eq!(
        s.send(json!({"type":"notebookSources"}))?,
        json!([{"name":"科目", "isSnapshot":false, "columns":first["columns"]}, {"name":"科目 (2)", "isSnapshot":false, "columns":first["columns"]}])
    );
    fs::write(first["sourceFile"].as_str().unwrap(), b"invalid parquet")?;
    assert_eq!(
        s.send(json!({"type":"notebookSources"}))?,
        json!([{"name":"科目 (2)", "isSnapshot":false, "columns":first["columns"]}])
    );
    fs::remove_file(first["sourceFile"].as_str().unwrap())?;
    assert_eq!(
        s.send(json!({"type":"notebookSources"}))?,
        json!([{"name":"科目 (2)", "isSnapshot":false, "columns":first["columns"]}])
    );
    s.send(json!({"type":"remove","id":first["id"]}))?;
    let book = s.send(json!({"type":"createNotebook","cellName":"查詢 1"}))?;
    let query = |sql: &str| {
        s.send(json!({"type":"runNotebook","id":book["id"],"cell":0,"sql":sql,"snapshot":false}))
    };
    assert!(query(r#"FROM "科目""#).is_err());
    assert_eq!(query(r#"FROM "科目 (2)""#)?["rows"][0][1], "2");
    Ok(())
}

#[test]
fn deleting_and_renaming_cells_preserves_other_results_and_snapshots() -> Result<()> {
    let s = Session::new()?;
    let mut book = s.send(json!({"type":"createNotebook","cellName":"First"}))?;
    let id = book["id"].clone();
    // A notebook written by the previous version has no explicit cell slots.
    book["cells"] = json!([{"name":"First","sql":"SELECT 1"},{"name":"Second","sql":"SELECT i FROM range(102) r(i) ORDER BY i"}]);
    s.send(json!({"type":"saveNotebook","book":book}))?;
    let run = |slot: usize, sql: &Value| {
        s.send(json!({"type":"runNotebook","id":id,"cell":slot,"sql":sql,"snapshot":true}))
    };
    let first = run(0, &book["cells"][0]["sql"])?;
    run(1, &book["cells"][1]["sql"])?;
    let mut remaining = book["cells"][1].clone();
    remaining["slot"] = json!(1);
    remaining["name"] = json!("明細");
    book["cells"] = json!([remaining]);
    s.send(json!({"type":"saveNotebook","book":book}))?;
    let page = |slot: usize| s.send(json!({"type":"notebookPage","id":id,"cell":slot,"start":100}));
    assert!(page(0).is_err());
    assert_eq!(page(1)?[0][1], "100");
    assert_eq!(
        run(1, &remaining["sql"])?["snapshot"]["displayName"],
        "SQL 1 · 明細"
    );
    assert_eq!(s.count(&first["snapshot"]["id"], json!({}))?, 1);
    let path = s.dir.path().join("remaining.lvnb.json");
    s.send(json!({"type":"exportNotebook","id":id,"path":path}))?;
    let file: Value = serde_json::from_slice(&fs::read(&path)?)?;
    assert_eq!(
        file["cells"],
        json!([{"name":"明細","sql":remaining["sql"]}])
    );
    book["cells"] = json!([]);
    s.send(json!({"type":"saveNotebook","book":book}))?;
    assert!(page(1).is_err());
    assert_eq!(
        s.send(json!({"type":"restore"}))?["notebooks"][0]["cells"],
        json!([])
    );
    Ok(())
}
