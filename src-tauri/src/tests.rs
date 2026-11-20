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
    dir: TempDir,
    engine: Engine,
}
impl Session {
    fn new() -> Result<Self> {
        let dir = tempdir()?;
        let engine = Engine::new(dir.path().join("state"))?;
        Ok(Self { dir, engine })
    }
    fn send(&self, req: Value) -> Result<Value> {
        self.engine
            .execute(serde_json::from_value(req)?, "test".into(), false)
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
    let report = s.engine.execute(command(), "trace".into(), true)?;
    assert_eq!(report["result"], 1);
    assert!(report["queries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_str().unwrap().contains("count(*)")));
    assert_eq!(s.engine.execute(command(), "plain".into(), false)?, 1);
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
