import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { confirm, save } from '@tauri-apps/plugin-dialog';
import { useMessages } from '../../i18n';
import { request } from '../../lib/native';
import { sanitizeFileName } from '../../lib/util/ids';
import { useDatasets } from '../../store/datasets';
import {
  appendCell,
  updateCell,
  deleteCell,
  editNotebook,
  flushNotebook,
  setOutput,
  useNotebooks,
} from '../../store/notebooks';
import { useSnapshots } from '../../store/snapshots';
import { useUi } from '../../store/ui';
import type { Notebook, SqlCell as Cell } from '../../types/notebook';
import { IconSnapshot } from '../common/icons';

function SqlCell({ book, cell, sources }: { book: Notebook; cell: Cell; sources: string[] }) {
  const t = useMessages().notebook;
  const slot = cell.slot;
  const key = book.id + '/' + slot;
  const out = useNotebooks((s) => s.outputs[key]);
  const input = useRef<HTMLTextAreaElement>(null);
  const result = out?.result;
  const start = out?.start ?? 0;
  const update = (sql: string) => updateCell(book.id, slot, { sql });
  const remove = async () => {
    try {
      if (await confirm(t.deleteCellConfirm(cell.name))) deleteCell(book.id, slot);
    } catch (err) {
      useUi.getState().toast('error', String(err));
    }
  };
  const run = async (snapshot: boolean) => {
    if (useNotebooks.getState().outputs[key]?.busy || !cell.sql.trim()) return;
    setOutput(book.id, slot, { busy: true });
    try {
      await flushNotebook(book.id);
      const result = await request('runNotebook', {
        id: book.id,
        cell: slot,
        sql: cell.sql,
        snapshot,
      });
      if (result.snapshot) useSnapshots.getState().addSnapshot(result.snapshot);
      setOutput(book.id, slot, { result, sql: cell.sql, start: 0 });
    } catch (err) {
      setOutput(book.id, slot, { error: String(err) });
    }
  };
  const page = async (offset: number) => {
    if (!result || useNotebooks.getState().outputs[key]?.busy) return;
    setOutput(book.id, slot, { ...out, error: undefined, busy: true });
    try {
      const rows = await request('notebookPage', { id: book.id, cell: slot, start: offset });
      setOutput(book.id, slot, { sql: out?.sql, result: { ...result, rows }, start: offset });
    } catch (err) {
      setOutput(book.id, slot, { ...out, error: String(err) });
    }
  };
  return (
    <section className="sql-cell" aria-label={cell.name}>
      <div className="sql-cell-toolbar">
        <input
          className="sql-cell-name"
          aria-label={t.cellName}
          defaultValue={cell.name}
          onChange={(e) => {
            const name = e.target.value.trim();
            if (name && name !== cell.name) updateCell(book.id, slot, { name });
          }}
          onBlur={(e) => {
            e.target.value = cell.name;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
          }}
        />
        <button
          className="btn"
          disabled={out?.busy || !cell.sql.trim()}
          onClick={() => void run(false)}
        >
          {t.run}
        </button>
        <button
          className="btn icon-btn"
          disabled={out?.busy || !cell.sql.trim()}
          onClick={() => void run(true)}
        >
          <IconSnapshot />
          {t.runSnapshot}
        </button>
        <button
          className="quiet-button delete-cell"
          aria-label={t.deleteCell + ' · ' + cell.name}
          title={t.deleteCell}
          onClick={() => void remove()}
        >
          ×
        </button>
      </div>
      <textarea
        ref={input}
        value={cell.sql}
        placeholder={t.placeholder}
        spellCheck={false}
        aria-label={cell.name + ' SQL'}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run(false);
          }
        }}
      />
      {sources.length > 0 && (
        <select
          className="sql-sources"
          value=""
          aria-label={t.sources}
          onChange={(e) => {
            const field = input.current;
            if (!field || !e.target.value) return;
            const quoted = '"' + e.target.value.replaceAll('"', '""') + '"';
            const insert = cell.sql.trim() ? quoted : 'SELECT * FROM ' + quoted + ';';
            const pos = field.selectionStart;
            update(cell.sql.slice(0, pos) + insert + cell.sql.slice(field.selectionEnd));
            requestAnimationFrame(() => {
              field.focus();
              field.setSelectionRange(pos + insert.length, pos + insert.length);
            });
          }}
        >
          <option value="">{t.sources}</option>
          {sources.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      )}
      {out?.busy && (
        <p className="sql-message" role="status">
          {t.running}
        </p>
      )}
      {out?.error && (
        <pre className="sql-error" role="alert">
          {out.error}
        </pre>
      )}
      {result && (
        <details className="query-result" open>
          <summary>
            {result.total.toLocaleString()} {t.rows} · {result.elapsedMs} ms
            {result.snapshot && (
              <span>
                {' '}
                · {t.snapCreated} {result.snapshot.displayName}
              </span>
            )}
            {cell.sql !== out.sql && <span> · {t.stale}</span>}
          </summary>
          <div className="query-scroll" tabIndex={0} aria-label={cell.name}>
            <table>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  {result.columns.map((c) => (
                    <th scope="col" key={c.name} title={c.duckdbType}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={row[0] ?? i}>
                    <th scope="row">{(start + i + 1).toLocaleString()}</th>
                    {row.slice(1).map((value, j) => (
                      <td key={j} className={value === null ? 'null-value' : undefined}>
                        {value ?? 'NULL'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.total > 100 && (
            <div className="query-pages">
              <button
                className="btn"
                disabled={!!out.busy || !start}
                onClick={() => void page(start - 100)}
              >
                {t.prev}
              </button>
              <span>
                {start + 1}–{start + result.rows.length} / {result.total.toLocaleString()}
              </span>
              <button
                className="btn"
                disabled={!!out.busy || start + result.rows.length >= result.total}
                onClick={() => void page(start + 100)}
              >
                {t.next}
              </button>
            </div>
          )}
        </details>
      )}
    </section>
  );
}

export function NotebookWorkspace() {
  const t = useMessages().notebook;
  const { books, activeId, saves } = useNotebooks();
  const book = books.find((b) => b.id === activeId);
  const status = book && saves[book.id];
  const { persistent, rowHeight, toast } = useUi();
  const datasets = useDatasets((s) => s.datasets);
  const snapshots = useSnapshots((s) => s.snapshots);
  const [sources, setSources] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const focusNewCell = useRef(false);
  useLayoutEffect(() => {
    if (!focusNewCell.current) return;
    focusNewCell.current = false;
    list.current?.querySelector<HTMLTextAreaElement>('.sql-cell:last-of-type textarea')?.focus();
  }, [book?.id, book?.cells.length]);

  useEffect(() => {
    let current = true;
    request('notebookSources', {})
      .then((names) => {
        if (current) setSources(names);
      })
      .catch((e) => {
        if (current) toast('error', String(e));
      });
    return () => {
      current = false;
    };
  }, [datasets, snapshots, toast]);
  const exportBook = async () => {
    if (!book) return;
    setExporting(true);
    try {
      const path = await save({
        defaultPath: sanitizeFileName(book.name) + '.lvnb.json',
        filters: [{ name: t.fileType, extensions: ['json'] }],
      });
      if (path) {
        await flushNotebook(book.id);
        await request('exportNotebook', { id: book.id, path });
        toast('success', t.exported);
      }
    } catch (err) {
      toast('error', String(err));
    } finally {
      setExporting(false);
    }
  };
  return (
    <main className="table-workspace notebook-workspace">
      <header className="table-toolbar notebook-toolbar">
        <span className="notebook-path">{t.title}</span>
        {book && (
          <>
            <input
              className="notebook-name"
              key={book.id}
              aria-label={t.name}
              defaultValue={book.name}
              style={{
                width:
                  Math.max(
                    5,
                    [...book.name].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0) + 2,
                  ) + 'ch',
              }}
              onChange={(e) => {
                const name = e.target.value.trim();
                if (name && name !== book.name) editNotebook({ ...book, name });
              }}
              onBlur={(e) => {
                e.target.value = book.name;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
              }}
            />
            <span className={'save-indicator ' + (status ?? 'saved')} role="status">
              {status === 'failed' ? (
                <button
                  onClick={() =>
                    void flushNotebook(book.id).catch((e) => toast('error', String(e)))
                  }
                >
                  {t.saveFailed}
                </button>
              ) : status === 'saving' ? (
                t.saving
              ) : persistent ? (
                t.saved
              ) : (
                t.memory
              )}
            </span>
          </>
        )}
        <div className="spacer" />
        <button className="btn" disabled={!book || exporting} onClick={() => void exportBook()}>
          {t.export}
        </button>
      </header>
      <div
        className="notebook-cells"
        key={book?.id}
        ref={list}
        style={{ '--query-row-height': rowHeight + 'px' } as CSSProperties}
      >
        {book?.cells.map((cell) => (
          <SqlCell key={cell.slot} book={book} cell={cell} sources={sources} />
        ))}
        {book && (
          <button
            className="btn add-sql"
            onClick={() => {
              focusNewCell.current = true;
              appendCell(book, t.cell);
            }}
          >
            {t.newCell}
          </button>
        )}
      </div>
      <footer className="statusbar" />
    </main>
  );
}
