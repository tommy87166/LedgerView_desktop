import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { QueryTable } from '../common/QueryTable';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useMessages } from '../../i18n';
import { applyAiNotebook, type AiCellEdit } from '../../store/notebooks';
import { useDiagnostics } from '../../store/diagnostics';
import { useDatasets } from '../../store/datasets';
import { useSnapshots } from '../../store/snapshots';
import { useUi } from '../../store/ui';
import type { ColumnMeta, DatasetMeta } from '../../types/dataset';
import type { StoredNotebook } from '../../types/notebook';
import type { SnapshotMeta } from '../../types/snapshot';

interface Info {
  url: string;
  token: string;
}
export function McpSettings() {
  const t = useMessages().mcp;
  const [info, setInfo] = useState<Info | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const report = (err: unknown) => setError(String(err));
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    invoke<Info | null>('mcp_info')
      .then((v) => {
        if (live) setInfo(v);
      })
      .catch((err) => {
        if (live) report(err);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const toggle = async (enabled: boolean) => {
    setPending(true);
    setError('');
    try {
      setInfo(await invoke<Info | null>('mcp_set_enabled', { enabled }));
    } catch (err) {
      report(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <label className="workspace-setting">
        {t.enable}
        <input
          type="checkbox"
          checked={!!info}
          disabled={pending}
          onChange={(e) => void toggle(e.target.checked)}
        />
      </label>
      {info && (
        <div className="mcp-connection">
          <code>{info.url}</code>
          <button
            className="btn"
            onClick={() => {
              void writeText(
                JSON.stringify(
                  { url: info.url, headers: { Authorization: 'Bearer ' + info.token } },
                  null,
                  2,
                ),
              )
                .then(() => useUi.getState().toast('success', t.copied))
                .catch(report);
            }}
          >
            {t.copy}
          </button>
        </div>
      )}
      {error && (
        <p className="sql-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

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
          </footer>
        </>
      ) : (
        <p>{t.notebook.running}</p>
      )}
    </dialog>
  );
}
