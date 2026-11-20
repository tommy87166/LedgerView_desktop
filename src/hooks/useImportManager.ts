import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { getMessages } from '../i18n';
import { request } from '../lib/native';
import { useDatasets } from '../store/datasets';
import { useUi } from '../store/ui';

export function useImportManager() {
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const queue = useRef(Promise.resolve());
  const enqueue = useCallback((paths: string[]) => {
    queue.current = queue.current.then(async () => {
      const t = getMessages();
      const toast = useUi.getState().toast;
      setImporting(true);
      try {
        for (const path of paths) {
          const name = path.split(/[/\\]/).pop() || path;
          if (!/\.parquet$/i.test(path)) {
            toast('error', t.import.unsupportedFormat(name));
            continue;
          }
          try {
            const bytes = await request('fileSize', { path });
            if (
              bytes > 10 * 1024 ** 3 &&
              !(await confirm(
                t.import.oversizeConfirm(name, (bytes / 1024 ** 3).toFixed(1) + ' GiB', '10 GiB'),
              ))
            )
              continue;
            const ds = await request('open', { path });
            useDatasets.getState().addDataset(ds);
            toast('success', t.import.imported(name, ds.rowCount.toLocaleString()));
          } catch (e) {
            toast('error', t.import.processFailed(name, String(e)));
          }
        }
      } finally {
        setImporting(false);
      }
    });
  }, []);
  const openPicker = async () => {
    try {
      const paths = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'Parquet', extensions: ['parquet'] }],
      });
      if (paths) enqueue(paths);
    } catch (e) {
      useUi.getState().toast('error', String(e));
    }
  };
  useEffect(() => {
    const subscription = getCurrentWebview().onDragDropEvent(({ payload }) => {
      setDragOver(payload.type === 'enter' || payload.type === 'over');
      if (payload.type === 'drop') enqueue(payload.paths);
    });
    return () => {
      void subscription.then((off) => off());
    };
  }, [enqueue]);
  return { importing, dragOver, openPicker };
}
