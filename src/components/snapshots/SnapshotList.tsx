import { useState } from 'react';
import type { SnapshotMeta } from '../../types/snapshot';
import { useSnapshots } from '../../store/snapshots';
import { useDatasets } from '../../store/datasets';
import { useUi } from '../../store/ui';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { request } from '../../lib/native';
import { sanitizeFileName } from '../../lib/util/ids';
import { IconSnapshot } from '../common/icons';
import { useMessages } from '../../i18n';

interface Props {
  activeId: string | null;
  onOpenPreview: (snap: SnapshotMeta) => void;
}

export function SnapshotList({ activeId, onOpenPreview }: Props) {
  const t = useMessages();
  const snapshots = useSnapshots((s) => s.snapshots);
  const removeSnapshot = useSnapshots((s) => s.removeSnapshot);
  const renameInStore = useSnapshots((s) => s.renameSnapshot);
  const removeDataset = useDatasets((s) => s.removeDataset);
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const onCopy = async (snap: SnapshotMeta) => {
    const cells = snap.rowCount * snap.columnCount;
    if (cells > 2_000_000) {
      toast('error', t.snapshot.copyTooLarge(cells.toLocaleString()));
      return;
    }
    if (cells > 200_000 && !(await confirm(t.snapshot.copyWarn))) return;
    try {
      await writeText(await request('clipboard', { id: snap.id }));
      toast('success', t.snapshot.copied);
    } catch (err) {
      toast('error', t.snapshot.copyFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  const onDownload = async (snap: SnapshotMeta) => {
    setBusy(true);
    try {
      const path = await save({
        defaultPath: sanitizeFileName(snap.displayName) + '.parquet',
        filters: [{ name: 'Parquet', extensions: ['parquet'] }],
      });
      if (path) await request('export', { id: snap.id, path });
    } catch (err) {
      toast('error', t.snapshot.downloadFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (snap: SnapshotMeta) => {
    if (!(await confirm(t.snapshot.deleteConfirm(snap.displayName)))) return;
    try {
      await request('remove', { id: snap.id });
      removeSnapshot(snap.id);
      // 若該快照的預覽分頁開著，一併關閉。
      removeDataset(snap.id);
    } catch (err) {
      toast('error', t.snapshot.deleteFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  const startEdit = (snap: SnapshotMeta) => {
    setEditingId(snap.id);
    setEditName(snap.displayName);
  };

  const commitEdit = async (snap: SnapshotMeta) => {
    const name = editName.trim();
    setEditingId(null);
    if (!name || name === snap.displayName) return;
    try {
      await request('rename', { id: snap.id, name });
      useDatasets.getState().renameDataset(snap.id, name);
      renameInStore(snap.id, name);
    } catch (err) {
      toast('error', t.snapshot.renameFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  if (!snapshots.length) return <p className="sidebar-empty">{t.snapshot.emptyLine1}</p>;

  return (
    <div className="snapshot-list">
      {snapshots.map((snap) => (
        <div key={snap.id} className={`snapshot-item${activeId === snap.id ? ' selected' : ''}`}>
          <div className="snapshot-heading">
            {editingId === snap.id ? (
              <input
                type="text"
                aria-label={t.snapshot.rename}
                value={editName}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => void commitEdit(snap)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditingId(null);
                }}
              />
            ) : (
              <button
                className="item-name"
                onClick={() => onOpenPreview(snap)}
                aria-current={activeId === snap.id ? 'true' : undefined}
                title={`${snap.displayName} · ${t.snapshot.sourcePrefix}${snap.sourceDisplayName} · ${snap.filterDesc || t.snapshot.noFilter} · ${t.snapshot.rows(snap.rowCount.toLocaleString())}`}
              >
                <IconSnapshot />
                <span>{snap.displayName}</span>
              </button>
            )}
            <button
              className="quiet-button delete-snapshot"
              aria-label={t.snapshot.delete(snap.displayName)}
              title={t.snapshot.delete(snap.displayName)}
              onClick={() => void onDelete(snap)}
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div className="snapshot-actions">
            <button onClick={() => void onCopy(snap)} disabled={busy}>
              {t.snapshot.copy}
            </button>
            <button onClick={() => startEdit(snap)} disabled={busy}>
              {t.snapshot.rename}
            </button>
            <button onClick={() => void onDownload(snap)} disabled={busy}>
              {t.snapshot.downloadParquet}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
