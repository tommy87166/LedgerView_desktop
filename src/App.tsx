import { useEffect } from 'react';
import { request } from './lib/native';
import { useDatasets } from './store/datasets';
import { useSnapshots } from './store/snapshots';
import { useUi } from './store/ui';
import { AppShell } from './components/layout/AppShell';
import { Toasts } from './components/common/Toasts';
import { ActivityOverlay } from './components/common/ActivityOverlay';
import { getMessages, useMessages } from './i18n';

export function App() {
  const t = useMessages();
  const dbReady = useUi((s) => s.dbReady);
  const dbError = useUi((s) => s.dbError);
  const setDbReady = useUi((s) => s.setDbReady);
  const setDbError = useUi((s) => s.setDbError);
  const setDatasets = useDatasets((s) => s.setDatasets);
  const setSnapshots = useSnapshots((s) => s.setSnapshots);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { persistent, catalog } = await request('restore', {});
        if (cancelled) return;
        setDatasets(catalog.datasets);
        setSnapshots(catalog.snapshots);
        setDbReady(persistent);
        for (const path of catalog.failed) toast('error', getMessages().app.reopenFailed(path));
      } catch (err) {
        if (cancelled) return;
        setDbError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setDbReady, setDbError, setDatasets, setSnapshots, toast]);

  return (
    <>
      {dbError ? (
        <div className="center-screen">
          <p>{t.app.dbInitFailed}</p>
          <pre>{dbError}</pre>
        </div>
      ) : !dbReady ? (
        <div className="center-screen">{t.app.initializing}</div>
      ) : (
        <AppShell />
      )}
      <Toasts />
      <ActivityOverlay />
    </>
  );
}
