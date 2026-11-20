use crate::ledger::{ident, Column, Dataset};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Filters = BTreeMap<String, Condition>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub filter_type: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<Condition>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub filter: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub filter_to: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_to: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub include_blanks: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub col_id: String,
    pub sort: String,
}

pub fn order(dataset: &Dataset, sort: &[Sort]) -> Result<String> {
    if sort.is_empty() {
        return Ok(String::new());
    }
    let mut clauses = Vec::new();
    for s in sort {
        let col = dataset.column(&s.col_id)?;
        ensure!(
            matches!(s.sort.as_str(), "asc" | "desc"),
            "Unknown sort direction"
        );
        clauses.push(format!("{} {} NULLS LAST", ident(&col.name), s.sort));
    }
    clauses.push(ident(&dataset.row_key));
    Ok(format!(" ORDER BY {}", clauses.join(", ")))
}

pub struct Predicate {
    pub sql: String,
    pub params: Vec<String>,
}

pub fn predicate(dataset: &Dataset, filters: &Filters) -> Result<Predicate> {
    let mut params = Vec::new();
    let mut clauses = Vec::new();
    for (name, cond) in filters {
        clauses.push(condition(dataset.column(name)?, cond, &mut params)?);
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    Ok(Predicate { sql, params })
}

fn condition(meta: &Column, c: &Condition, params: &mut Vec<String>) -> Result<String> {
    if let Some(join) = &c.operator {
        ensure!(
            matches!(join.as_str(), "AND" | "OR") && !c.conditions.is_empty(),
            "Invalid compound filter"
        );
        let parts = c
            .conditions
            .iter()
            .map(|f| condition(meta, f, params))
            .collect::<Result<Vec<_>>>()?;
        return Ok(format!("({})", parts.join(&format!(" {join} "))));
    }
    let col = ident(&meta.name);
    let text = format!("CAST({col} AS VARCHAR)");
    if c.filter_type == "set" {
        let mut parts = Vec::new();
        if !c.values.is_empty() {
            // One bound list for an entire voucher selection, including very large lists.
            params.push(serde_json::to_string(&c.values)?);
            parts.push(format!(
                "{text} IN (SELECT unnest(CAST(CAST(? AS JSON) AS VARCHAR[])))"
            ));
        }
        if c.include_blanks {
            parts.push(format!("{col} IS NULL"));
            if meta.display_type == "text" {
                parts.push(format!("{text} = ''"));
            }
        }
        return Ok(if parts.is_empty() {
            "FALSE".into()
        } else {
            format!("({})", parts.join(" OR "))
        });
    }
    let op = c.op.as_deref().context("Missing comparison")?;
    if matches!(op, "blank" | "notBlank") {
        let blank = if meta.display_type == "text" {
            format!("({col} IS NULL OR {text} = '')")
        } else {
            format!("{col} IS NULL")
        };
        return Ok(if op == "blank" {
            blank
        } else {
            format!("NOT ({blank})")
        });
    }
    if c.filter_type == "text" {
        let val = c.filter.as_str().unwrap_or("");
        if matches!(op, "equals" | "notEqual") {
            params.push(val.into());
            return Ok(if op == "equals" {
                format!("lower({text}) = lower(?)")
            } else {
                format!("({col} IS NULL OR lower({text}) <> lower(?))")
            });
        }
        let pattern = val
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        params.push(match op {
            "contains" | "notContains" => format!("%{pattern}%"),
            "startsWith" => format!("{pattern}%"),
            "endsWith" => format!("%{pattern}"),
            _ => bail!("Unknown text comparison"),
        });
        let clause = format!("{text} ILIKE ? ESCAPE '\\'");
        return Ok(if op == "notContains" {
            format!("({col} IS NULL OR NOT ({clause}))")
        } else {
            clause
        });
    }
    let date = c.filter_type == "date";
    ensure!(date || c.filter_type == "number", "Unknown filter type");
    let lhs = if date {
        format!("{col}::DATE")
    } else {
        col.clone()
    };
    let mut bind = |upper: bool| -> Result<String> {
        if date {
            let value = if upper { &c.date_to } else { &c.date_from };
            let value = value
                .as_deref()
                .context("Missing date")?
                .split([' ', 'T'])
                .next()
                .unwrap_or("");
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")?;
            params.push(value.into());
            return Ok("CAST(? AS DATE)".into());
        }
        let raw = if upper { &c.filter_to } else { &c.filter };
        let num = match raw {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => bail!("Missing number"),
        };
        let parsed = num.parse::<f64>()?;
        ensure!(parsed.is_finite(), "Invalid number");
        let (mantissa, exponent) = match num.split_once(['e', 'E']) {
            Some((m, e)) => (m, e.parse::<i32>()?),
            None => (num.as_str(), 0),
        };
        let fraction = mantissa
            .split_once('.')
            .map_or("", |(_, s)| s.trim_end_matches('0'));
        let scale = (fraction.len() as i64 - i64::from(exponent)).max(0);
        let target = if matches!(meta.duckdb_type.as_str(), "DOUBLE" | "FLOAT") {
            "DOUBLE".into()
        } else if scale == 0 && meta.duckdb_type == "UHUGEINT" && !num.starts_with('-') {
            "UHUGEINT".into()
        } else if scale == 0 {
            "HUGEINT".into()
        } else {
            ensure!(scale <= 38, "Decimal scale exceeds DuckDB precision");
            format!("DECIMAL(38,{scale})")
        };
        params.push(num);
        Ok(format!("CAST(? AS {target})"))
    };
    let first = bind(false)?;
    if op == "inRange" {
        return Ok(format!("{lhs} BETWEEN {first} AND {}", bind(true)?));
    }
    let cmp = match op {
        "equals" => "=",
        "notEqual" => "<>",
        "lessThan" => "<",
        "lessThanOrEqual" => "<=",
        "greaterThan" => ">",
        "greaterThanOrEqual" => ">=",
        _ => bail!("Unknown comparison"),
    };
    let sql = format!("{lhs} {cmp} {first}");
    Ok(if op == "notEqual" {
        format!("({col} IS NULL OR {sql})")
    } else {
        sql
    })
}
