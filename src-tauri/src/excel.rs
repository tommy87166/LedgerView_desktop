// Snapshots have dense, zero-based row ordinals. Read ranges in snapshot order
// so neither DuckDB nor the workbook writer needs to buffer the entire export.
use crate::ledger::{ident, Column, Dataset};
use anyhow::{ensure, Context, Result};
use duckdb::Connection;
use rust_xlsxwriter::{ExcelDateTime, Format, Workbook, Worksheet};
use std::fs::File;

const DATA_ROWS_PER_SHEET: i64 = 1_048_575;
const BATCH: i64 = 4096;

pub fn write(conn: &Connection, ds: &Dataset, dest: &mut File) -> Result<()> {
    write_checked(conn, ds, dest, &|| Ok(()))
}

pub fn write_checked(
    conn: &Connection,
    ds: &Dataset,
    dest: &mut File,
    check: &(dyn Fn() -> Result<()> + Sync),
) -> Result<()> {
    check()?;
    ensure!(
        ds.columns.len() <= 16_384,
        "Excel supports at most 16,384 columns"
    );
    let mut book = Workbook::new();
    book.use_zip_large_file(true);
    let header = Format::new().set_bold();
    let blank = Format::new();
    let date = Format::new().set_num_format("yyyy-mm-dd");
    let fields = ds
        .columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let key = ident(&ds.row_key);
    let sql = format!(
        "SELECT {fields} FROM {} WHERE {key} >= ? AND {key} < ? ORDER BY {key}",
        ds.relation()
    );
    let mut statement = conn.prepare(&sql)?;
    let mut offset = 0;
    loop {
        let sheet = book.add_worksheet_with_constant_memory()?;
        sheet.set_freeze_panes(1, 0)?;
        for (col, meta) in ds.columns.iter().enumerate() {
            sheet.write_string_with_format(0, col as u16, &meta.name, &header)?;
        }
        let sheet_start = offset;
        let end = ds.row_count.min(sheet_start + DATA_ROWS_PER_SHEET);
        while offset < end {
            check()?;
            let batch_end = end.min(offset + BATCH);
            let mut rows = statement.query([offset, batch_end])?;
            while let Some(values) = rows.next()? {
                if offset % 128 == 0 {
                    check()?;
                }
                let row = (offset - sheet_start + 1) as u32;
                let mut all_null = true;
                for (index, meta) in ds.columns.iter().enumerate() {
                    if let Some(value) = values.get::<_, Option<String>>(index)? {
                        all_null = false;
                        write_cell(sheet, row, index as u16, meta, &value, &date).with_context(
                            || format!("Exporting row {}, column {}", offset + 1, meta.name),
                        )?;
                    }
                }
                if all_null {
                    sheet.write_blank(row, 0, &blank)?;
                }
                offset += 1;
            }
            ensure!(
                offset == batch_end,
                "Snapshot row count does not match its contents"
            );
        }
        if offset == ds.row_count {
            break;
        }
    }
    check()?;
    // ZIP compression also writes in chunks, after the last database batch.
    struct CheckedWriter<'a> {
        dest: &'a mut File,
        check: &'a (dyn Fn() -> Result<()> + Sync),
    }
    impl std::io::Write for CheckedWriter<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            (self.check)().map_err(std::io::Error::other)?;
            self.dest.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.dest.flush()
        }
    }
    book.save_to_writer(CheckedWriter { dest, check })?;
    Ok(())
}

fn write_cell(
    sheet: &mut Worksheet,
    row: u32,
    col: u16,
    meta: &Column,
    value: &str,
    date: &Format,
) -> Result<()> {
    if meta.display_type == "boolean" {
        sheet.write_boolean(row, col, value == "true")?;
        return Ok(());
    }
    if meta.display_type == "number" {
        let number = match meta.duckdb_type.as_str() {
            "FLOAT" | "DOUBLE" => value.parse::<f64>().ok().filter(|n| n.is_finite()),
            _ => excel_number(value),
        };
        if let Some(n) = number {
            sheet.write_number(row, col, n)?;
            return Ok(());
        }
    }
    if meta.display_type == "date" && value.len() == 10 && value >= "1900-01-01" {
        if let Ok(d) = ExcelDateTime::parse_from_str(value) {
            sheet.write_datetime_with_format(row, col, &d, date)?;
            return Ok(());
        }
    }
    // String cells preserve IDs, timestamp precision, and literal leading '=' characters.
    sheet.write_string(row, col, value)?;
    Ok(())
}

fn excel_number(text: &str) -> Option<f64> {
    let mantissa = text
        .split(['e', 'E'])
        .next()?
        .trim_start_matches(['-', '+']);
    let mantissa = if mantissa.contains('.') {
        mantissa.trim_end_matches('0')
    } else {
        mantissa
    };
    let digits = mantissa.replace('.', "");
    if digits.trim_start_matches('0').len() > 15 {
        return None;
    }
    let n: f64 = text.parse().ok()?;
    (n == 0.0 || n.is_normal()).then_some(n)
}
