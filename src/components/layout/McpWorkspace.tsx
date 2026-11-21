import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { QueryTable } from '../common/QueryTable';
import { IconSnapshot } from '../common/icons';
import { listen } from '@tauri-apps/api/event';
import { useMessages } from '../../i18n';
import { applyAiNotebook, type AiCellEdit } from '../../store/notebooks';
import { useDiagnostics } from '../../store/diagnostics';
import { useDatasets } from '../../store/datasets';
import { useSnapshots } from '../../store/snapshots';
import type { ColumnMeta, DatasetMeta } from '../../types/dataset';
import type { StoredNotebook } from '../../types/notebook';
import type { SnapshotMeta } from '../../types/snapshot';

import { updating, useUpdates } from '../../store/updates';

type McpEvent =
  | { type: 'begin'; token: string; sql: string }
  | { type: 'finish'; token: string; sql: string; elapsedMs: number; error?: string }
  | { type: 'preview'; resultId: string }
  | { type: 'snapshot'; snapshot: SnapshotMeta; dataset: DatasetMeta; focus: boolean }
  | {
      type: 'edit';
      ticket: string;
      before: StoredNotebook | null;
      name: string;
      cells: AiCellEdit[];
    };
interface Page {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  total: number;
  next: number | null;
  start: number;
}

export function McpWorkspace() {
  const t = useMessages();
  const [preview, setPreview] = useState<string | null>(null);
  const [offsets, setOffsets] = useState([0]);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ id: string; text: string; failed: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let live = true;
    const listener = listen<McpEvent>('mcp-workspace', async ({ payload: e }) => {
      if (!live) return;
      switch (e.type) {
        case 'begin':
          useDiagnostics
            .getState()
            .begin({ token: e.token, operation: 'MCP', started: Date.now(), sql: e.sql });
          break;
        case 'finish':
          useDiagnostics
            .getState()
            .finish(e.token, e.elapsedMs, [{ sql: e.sql }], e.error ?? undefined);
          break;
        case 'preview':
          setNotice(null);
          setOffsets([0]);
          setPreview(e.resultId);
          break;
        case 'snapshot': {
          useSnapshots.setState((s) => ({
            snapshots: [e.snapshot, ...s.snapshots.filter((x) => x.id !== e.snapshot.id)],
          }));
          useDatasets.setState((s) => {
            const open = s.datasets.some((d) => d.id === e.dataset.id);
            const datasets = open
              ? s.datasets.map((d) => (d.id === e.dataset.id ? e.dataset : d))
              : e.focus
                ? [...s.datasets, e.dataset]
                : s.datasets;
            return { datasets, activeId: e.focus ? e.dataset.id : s.activeId };
          });
          if (e.focus) setPreview(null);
          break;
        }
        case 'edit': {
          let result, error;
          try {
            await invoke('mcp_claim_edit', { ticket: e.ticket });
            if (updating(useUpdates.getState().phase)) throw Error('LedgerView is updating. Retry after restart.');
            result = await applyAiNotebook(e.before, e.name, e.cells);
          } catch (cause) {
            error = String(cause);
          }
          await invoke('mcp_edit_reply', { ticket: e.ticket, result, error }).catch(() => {});
          break;
        }
      }
    });
    void listener.catch(() => {});
    return () => {
      live = false;
      void listener.then((stop) => stop()).catch(() => {});
    };
  }, []);
  const start = offsets[offsets.length - 1];
  useEffect(() => {
    if (!preview) {
      dialog.current?.close();
      return;
    }
    if (!dialog.current?.open) dialog.current?.showModal();
    setPage(null);
    setError('');
    let live = true;
    invoke<Page>('mcp_page', { resultId: preview, start })
      .then((v) => {
        if (live) setPage(v);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [preview, start]);

  const saveSnapshot = async () => {
    if (!preview || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await invoke<{ name: string; total: number }>('mcp_snapshot_preview', { resultId: preview });
      setNotice({ id: preview, text: t.snapshot.created(saved.name, saved.total.toLocaleString()), failed: false });
    } catch (e) {
      setNotice({ id: preview, text: t.snapshot.createFailed(String(e)), failed: true });
    } finally {
      setSaving(false);
    }
  };
  return (
    <dialog
      className="settings-dialog mcp-preview"
      ref={dialog}
      onClose={() => setPreview(null)}
      aria-label={t.mcp.preview}
    >
      <header>
        <h2>{t.mcp.preview}</h2>
        <form method="dialog">
          <button className="quiet-button" aria-label={t.common.close}>
            ×
          </button>
        </form>
      </header>
      {error ? (
        <p role="alert" className="sql-error">
          {error}
        </p>
      ) : page ? (
        <>
          <QueryTable label={t.mcp.preview} columns={page.columns} rows={page.rows} start={start} />
          <footer>
            <div className="mcp-snapshot-action">
              <button className="btn icon-btn" disabled={saving} onClick={() => void saveSnapshot()}>
                <IconSnapshot />{saving ? t.notebook.saving : t.topbar.createSnapshot}
              </button>
              {notice && notice.id === preview && <span role={notice.failed ? 'alert' : 'status'}>{notice.text}</span>}
            </div>
            <div className="mcp-preview-pages">
              <span>
                {page.total.toLocaleString()} {t.notebook.rows}
              </span>
              <button
                className="btn"
                disabled={offsets.length === 1}
                onClick={() => setOffsets(offsets.slice(0, -1))}
              >
                {t.notebook.prev}
              </button>
              <button
                className="btn"
                disabled={page.next === null}
                onClick={() => {
                  if (page.next !== null) setOffsets([...offsets, page.next]);
                }}
              >
                {t.notebook.next}
              </button>
            </div>
          </footer>
        </>
      ) : (
        <p>{t.notebook.running}</p>
      )}
    </dialog>
  );
}
