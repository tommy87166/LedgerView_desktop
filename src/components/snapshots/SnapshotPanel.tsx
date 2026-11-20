import { useState } from 'react';
import type { SnapshotMeta } from '../../types/snapshot';
import { useSnapshots } from '../../store/snapshots';
import { useDatasets } from '../../store/datasets';
import { useUi } from '../../store/ui';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { request } from '../../lib/native';
import { sanitizeFileName } from '../../lib/util/ids';
import { IconCopy, IconRename, IconTrash, IconDownload } from '../common/icons';
import { useMessages } from '../../i18n';

interface Props {
  width: number;
  onResize: (w: number) => void;
  onOpenPreview: (snap: SnapshotMeta) => void;
}

export function SnapshotPanel({ width, onResize, onOpenPreview }: Props) {
  const t = useMessages();
  const snapshots = useSnapshots((s) => s.snapshots);
  const removeSnapshot = useSnapshots((s) => s.removeSnapshot);
  const renameInStore = useSnapshots((s) => s.renameSnapshot);
  const removeDataset = useDatasets((s) => s.removeDataset);
  const toast = useUi((s) => s.toast);
  const closePane = useUi((s) => s.toggleSnapshotPane);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  // 拖曳左緣調整面板寬度。
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      onResize(Math.min(720, Math.max(260, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

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

  return (
    <div className="side-panel" style={{ flex: `0 0 ${width}px`, width }}>
      <div className="resizer" onMouseDown={startResize} title={t.snapshot.resizeTooltip} />
      <h2 className="side-panel-head">
        <span>
          {t.snapshot.paneTitle}（{snapshots.length}）
        </span>
        <span className="close" title={t.snapshot.closeTooltip} onClick={closePane}>
          ×
        </span>
      </h2>

      <div className="snap-list">
        {snapshots.length === 0 ? (
          <div className="hint" style={{ padding: 14, lineHeight: 1.6 }}>
            {t.snapshot.emptyLine1}
            <br />
            {t.snapshot.emptyLine2(t.topbar.createSnapshot)}
          </div>
        ) : (
          snapshots.map((snap) => (
            <div key={snap.id} className="snap-item">
              {editingId === snap.id ? (
                <input
                  type="text"
                  value={editName}
                  autoFocus
                  style={{ width: '100%' }}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => void commitEdit(snap)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitEdit(snap);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <button
                  className="snap-name-btn"
                  title={t.snapshot.openPreviewTooltip}
                  onClick={() => onOpenPreview(snap)}
                >
                  {snap.displayName}
                </button>
              )}
              <div className="desc">
                {t.snapshot.sourcePrefix}
                {snap.sourceDisplayName}
                {snap.filterDesc ? ` ｜ ${snap.filterDesc}` : ` ｜ ${t.snapshot.noFilter}`}
              </div>
              <div className="hint">{t.snapshot.rows(snap.rowCount.toLocaleString())}</div>

              <div className="snap-actions">
                <button className="btn icon-btn" onClick={() => onCopy(snap)} disabled={busy}>
                  <IconCopy />
                  {t.snapshot.copy}
                </button>
                <button className="btn icon-btn" onClick={() => startEdit(snap)} disabled={busy}>
                  <IconRename />
                  {t.snapshot.rename}
                </button>
                <button
                  className="btn icon-btn danger"
                  onClick={() => onDelete(snap)}
                  disabled={busy}
                >
                  <IconTrash />
                  {t.snapshot.delete}
                </button>
              </div>
              <div className="snap-actions">
                <button className="btn icon-btn" onClick={() => onDownload(snap)} disabled={busy}>
                  <IconDownload />
                  {t.snapshot.downloadParquet}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
