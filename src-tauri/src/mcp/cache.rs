use anyhow::{ensure, Context, Result};
use fs2::FileExt;
use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::{RwLock, RwLockReadGuard},
};

// Only the session directory holds disposable data. The sibling lock stays in
// place so every app instance locks the same file, even across cleanup.
pub(super) struct Cache {
    pub directory: PathBuf,
    session: PathBuf,
    owner: RwLock<Option<File>>,
}

fn lock(root: &Path) -> io::Result<File> {
    fs::create_dir_all(root)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("owner.lock"))?;
    file.try_lock_exclusive()?;
    Ok(file)
}

fn remove_session(directory: &Path) -> io::Result<()> {
    match fs::remove_dir_all(directory) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(crate) fn clean_stale(root: &Path) -> Result<()> {
    if !root.try_exists()? {
        return Ok(());
    }
    let _owner = match lock(root) {
        Ok(owner) => owner,
        Err(e) if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    Ok(remove_session(&root.join("session"))?)
}

impl Cache {
    pub fn open(root: &Path) -> Result<Self> {
        let owner = lock(root).context("Opening LedgerView MCP cache")?;
        let session = root.join("session");
        remove_session(&session)?;
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&session)?;
        // A result handle can outlive shutdown. Its TempDir must never point
        // into a subsequent service's files, even when MCP is re-enabled.
        let directory = session.join(uuid::Uuid::new_v4().to_string());
        builder.create(&directory)?;
        Ok(Self {
            directory,
            session,
            owner: RwLock::new(Some(owner)),
        })
    }

    // Hold this guard until all DuckDB handles using the files have closed.
    pub fn access(&self) -> Result<RwLockReadGuard<'_, Option<File>>> {
        let owner = self.owner.read().unwrap();
        ensure!(owner.is_some(), "MCP is disabled");
        Ok(owner)
    }

    pub fn close(&self) -> Result<()> {
        let mut owner = self.owner.write().unwrap();
        if let Some(_lock) = owner.take() {
            remove_session(&self.session)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_removes_abandoned_cache_and_skips_a_live_owner() -> Result<()> {
        let root = tempfile::tempdir()?;
        let cache = Cache::open(root.path())?;
        let result = cache.directory.join("result.parquet");
        fs::write(&result, b"partial result")?;
        let other = root.path().join("keep.parquet");
        fs::write(&other, b"outside session")?;

        clean_stale(root.path())?;
        assert!(result.exists());
        // Releasing only the OS lock simulates a process that skipped shutdown.
        drop(cache);
        clean_stale(root.path())?;
        clean_stale(root.path())?;
        assert!(!result.exists());
        assert!(other.exists());
        Ok(())
    }
}
