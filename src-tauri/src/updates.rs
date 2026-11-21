// Only native code chooses the feed, artifact and destination. The webview can
// request the checked release by version, but cannot supply a URL or a file.
use anyhow::{anyhow, ensure, Context, Result};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Updates(Mutex<Option<Candidate>>);
struct Candidate {
    update: Update,
    verified: Option<Vec<u8>>,
}

fn artifact_name() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("LedgerView.app.tar.gz"),
        ("windows", "x86_64") => Ok("LedgerView.exe"),
        _ => Err(anyhow!("No LedgerView update package for this platform")),
    }
}

fn check_asset(version: &str, url: &str, name: &str) -> Result<()> {
    let expected = format!(
        "https://github.com/tommy87166/LedgerView_desktop/releases/download/{version}/{name}"
    );
    ensure!(url == expected, "Unexpected update download location");
    Ok(())
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
) -> Result<Option<String>, String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let updater = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let name = artifact_name().map_err(|e| e.to_string())?;
    check_asset(&update.version, update.download_url.as_str(), name).map_err(|e| e.to_string())?;
    update.timeout = Some(std::time::Duration::from_secs(300));
    let version = update.version.clone();
    *slot = Some(Candidate {
        update,
        verified: None,
    });
    Ok(Some(version))
}

#[tauri::command]
pub async fn download_update(state: State<'_, Updates>, version: String) -> Result<(), String> {
    let mut slot = state.0.lock().await;
    let c = slot
        .as_mut()
        .filter(|c| c.update.version == version)
        .ok_or("Check for updates again")?;
    if c.verified.is_none() {
        // Tauri validates both the signature and its authenticated app version.
        c.verified = Some(
            c.update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?,
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install(update: &Update, bytes: &[u8]) -> Result<()> {
    install_bundle(update, bytes, &std::env::current_exe()?)
}

#[cfg(target_os = "macos")]
fn install_bundle(update: &Update, bytes: &[u8], exe: &std::path::Path) -> Result<()> {
    let app = exe
        .ancestors()
        .nth(3)
        .context("Missing application bundle")?;
    ensure!(
        app.extension().is_some_and(|ext| ext == "app")
            && exe.parent() == Some(&app.join("Contents/MacOS")),
        "Open the packaged LedgerView.app to install updates"
    );
    update.install(bytes)?;
    Ok(())
}

#[cfg(windows)]
fn install(update: &Update, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    update.verify(bytes)?;
    ensure!(bytes.starts_with(b"MZ"), "Expected a Windows executable");
    let target = std::env::current_exe()?;
    let dir = tempfile::Builder::new()
        .prefix(".ledgerview-update-")
        .tempdir_in(target.parent().context("Missing executable directory")?)?;
    let replacement = dir.path().join("new.exe");
    {
        let mut f = std::fs::File::create(&replacement)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // self-replace moves the running image before copying the new one. Keep
    // a recoverable copy on the same volume in case that final copy fails.
    let backup = dir.path().join("previous.exe");
    if std::fs::hard_link(&target, &backup).is_err() {
        std::fs::copy(&target, &backup)?;
    }
    if let Err(err) = self_replace::self_replace(&replacement) {
        if !target.try_exists().unwrap_or(false) && std::fs::rename(&backup, &target).is_err() {
            let path = dir.keep();
            return Err(anyhow!(
                "Update failed ({err}). Previous executable saved in {}",
                path.display()
            ));
        }
        return Err(err.into());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install(_: &Update, _: &[u8]) -> Result<()> {
    Err(anyhow!("Unsupported update platform"))
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    let mut slot = state.0.lock().await;
    let c = slot
        .as_mut()
        .filter(|c| c.update.version == version)
        .ok_or("Check for updates again")?;
    let bytes = c
        .verified
        .take()
        .ok_or("Download the verified update first")?;
    let update = c.update.clone();
    tauri::async_runtime::spawn_blocking(move || install(&update, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    *slot = None;
    // RunEvent::Exit shuts down MCP and closes the catalog before Tauri relaunches.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_is_pinned_to_the_release_version_and_platform() {
        let url = "https://github.com/tommy87166/LedgerView_desktop/releases/download/1.2.0/LedgerView.exe";
        assert!(check_asset("1.2.0", url, "LedgerView.exe").is_ok());
        assert!(check_asset("1.2.1", url, "LedgerView.exe").is_err());
        assert!(check_asset("1.2.0", url, "LedgerView.app.tar.gz").is_err());
        assert!(check_asset("1.2.0", "https://example.org/update.exe", "LedgerView.exe").is_err());
    }
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod package_tests;
