use super::*;
use std::path::Path;

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ExportArgs {
    /// Export a saved workspace snapshot. Supply exactly one of snapshotId or resultId.
    snapshot_id: Option<String>,
    /// Export the full cached query result identified by query's resultId.
    result_id: Option<String>,
    /// An .xlsx filename directly inside the workspace. Defaults to the source ID plus .xlsx.
    file_name: Option<String>,
}

fn check_filename(name: &str) -> Result<()> {
    let valid = !name.starts_with(['.', ' '])
        && name.trim_end() == name
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(char::is_control)
        && Path::new(name)
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case("xlsx"));
    ensure!(valid, "Choose an .xlsx filename without a directory");
    // Windows device names apply even when followed by an extension.
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    ensure!(!device, "Choose a regular .xlsx filename");
    Ok(())
}

impl Workspace {
    pub(super) fn export_excel(
        &self,
        args: ExportArgs,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        // Shutdown drains active writers so their unfinished files are removed before exit.
        let _active = self.exports.token();
        let source_id = match (&args.snapshot_id, &args.result_id) {
            (Some(id), None) | (None, Some(id)) => id,
            _ => anyhow::bail!("Supply exactly one of snapshotId or resultId"),
        };
        let name = args
            .file_name
            .unwrap_or_else(|| format!("{source_id}.xlsx"));
        check_filename(&name)?;
        let path = self.engine.directory.join(name);
        ensure!(
            !path.try_exists()?,
            "File already exists. Choose a different filename"
        );
        let check = || self.check_request(cancel);
        check()?;
        let mut output = tempfile::NamedTempFile::new_in(&self.engine.directory)
            .context("Opening the workspace directory for Excel export")?;
        let total = if args.result_id.is_some() {
            let _access = self.cache.access()?;
            let file = self.result(source_id)?;
            let conn = Connection::open_in_memory()?;
            query::interruptible(&conn, check, || {
                crate::excel::write_checked(&conn, &file.dataset, output.as_file_mut(), &check)
            })?;
            file.dataset.row_count
        } else {
            let conn = self.engine.reader()?;
            query::interruptible(&conn, check, || {
                let tx = conn.unchecked_transaction()?;
                let ds = ledger::dataset(&tx, source_id)?;
                ensure!(ds.ephemeral, "Select a snapshot");
                crate::excel::write_checked(&tx, &ds, output.as_file_mut(), &check)?;
                tx.commit()?;
                Ok(ds.row_count)
            })?
        };
        check()?;
        // Atomically publish only a new name, including when concurrent calls
        // choose the same destination or it is already a (possibly dangling) symlink.
        output
            .persist_noclobber(&path)
            .context("Saving the Excel workbook")?;
        Ok(json!({"path":path, "total":total}))
    }
}
