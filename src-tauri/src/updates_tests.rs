use super::*;
use axum::{routing::get, Router};
use serde_json::json;
use std::{fs, path::Path};
use tauri::test::{mock_builder, mock_context, noop_assets};

// CI supplies bytes from this runner's finished package and a signature made
// with a disposable test key. Production has no configurable feed or key.
async fn download_fixture(dir: &Path, exe: &Path) -> Result<(Update, Vec<u8>)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let version = "99.0.0";
    let manifest = json!({"version":version,"platforms":{"fixture":{
        "url":format!("{base}/package"), "signature":fs::read_to_string(dir.join("package.sig"))?.trim()}}});
    let path = dir.join("package");
    let server_manifest = manifest.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route(
                    "/latest.json",
                    get(move || async { server_manifest.to_string() }),
                )
                .route("/package", get(move || async { fs::read(path).unwrap() })),
        )
        .await
    });

    let mut context = mock_context(noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey":fs::read_to_string(dir.join("public.key"))?.trim(),
            "endpoints":[format!("{base}/latest.json")],
            "dangerousInsecureTransportProtocol":true, "requireSignedVersion":true
        }),
    );
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)?;
    let updater = app
        .updater_builder()
        .no_proxy()
        .target("fixture")
        .executable_path(exe)
        .build()?;
    let update = updater.check().await?.context("Expected a newer version")?;
    let payload = update.download(|_, _| {}, || {}).await?;
    assert!(update.verify(b"corrupt download").is_err());
    let mut wrong_version = manifest.clone();
    wrong_version["version"] = json!("99.0.1");
    assert!(updater
        .restore_update(wrong_version)?
        .unwrap()
        .verify(&payload)
        .is_err());
    let mut missing = update.clone();
    missing.download_url = format!("{base}/missing").parse()?;
    assert!(missing.download(|_, _| {}, || {}).await.is_err());
    server.abort();
    Ok((update, payload))
}

#[tokio::test]
async fn signed_update_replaces_an_isolated_copy() -> Result<()> {
    let Some(fixture) = std::env::var_os("LEDGERVIEW_TEST_UPDATE_DIR") else {
        return Ok(());
    };
    let dir = tempfile::tempdir()?;
    #[cfg(target_os = "macos")]
    {
        let bundle = dir.path().join("LedgerView.app");
        let exe = bundle.join("Contents/MacOS/LedgerView");
        fs::create_dir_all(exe.parent().unwrap())?;
        fs::write(&exe, b"previous binary")?;
        let (update, bytes) = download_fixture(Path::new(&fixture), &exe).await?;
        install_bundle(&update, &bytes, &exe)?;
        assert!(exe.metadata()?.len() > 1024);
        assert!(std::process::Command::new("codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .status()?
            .success());
    }
    #[cfg(windows)]
    {
        let exe = dir.path().join("LedgerView copy.exe");
        fs::copy(std::env::current_exe()?, &exe)?;
        let status = std::process::Command::new(&exe)
            .args([
                "--exact",
                "updates::package_tests::replace_this_test_process",
                "--ignored",
            ])
            .env("LEDGERVIEW_TEST_RUNNING_COPY", &exe)
            .status()?;
        ensure!(status.success(), "Update test child failed");
        assert_eq!(
            fs::read(&exe)?,
            fs::read(Path::new(&fixture).join("package"))?
        );
    }
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "run by signed_update_replaces_an_isolated_copy in a disposable copy"]
async fn replace_this_test_process() -> Result<()> {
    let exe = std::env::current_exe()?;
    let expected =
        std::env::var_os("LEDGERVIEW_TEST_RUNNING_COPY").context("Expected disposable copy")?;
    ensure!(exe.canonicalize()? == Path::new(&expected).canonicalize()?);
    ensure!(exe.file_name().is_some_and(|n| n == "LedgerView copy.exe"));
    let fixture =
        std::env::var_os("LEDGERVIEW_TEST_UPDATE_DIR").context("Expected signed fixture")?;
    let (update, payload) = download_fixture(Path::new(&fixture), &exe).await?;
    install(&update, &payload)
}
