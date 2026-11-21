import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
import { SqlEditor } from './SqlEditor';
import { notebookLanguage } from '../../lib/notebookSql';
import type { Extension } from '@codemirror/state';
import type {
  Notebook,
  NotebookSource,
  SqlVocabulary,
  SqlCell as Cell,
} from '../../types/notebook';
import { QueryTable } from '../common/QueryTable';
import { IconSnapshot } from '../common/icons';

let vocabulary: Promise<SqlVocabulary> | undefined;
function loadVocabulary() {
  return (vocabulary ??= request('sqlVocabulary', {}).catch((error) => {
    vocabulary = undefined;
    throw error;
  }));
}

function SqlCell({
  book,
  cell,
  sources,
  language,
}: {
  book: Notebook;
  cell: Cell;
  sources: NotebookSource[];
  language: Extension;
}) {
  const t = useMessages().notebook;
  const slot = cell.slot;
  const key = book.id + '/' + slot;
  const out = useNotebooks((s) => s.outputs[key]);
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
  const run = async (snapshot: boolean, sql = cell.sql) => {
    if (useNotebooks.getState().outputs[key]?.busy || !sql.trim()) return;
    setOutput(book.id, slot, { busy: true });
    try {
      await flushNotebook(book.id);
      const result = await request('runNotebook', {
        id: book.id,
        cell: slot,
        sql,
        snapshot,
      });
      if (result.snapshot) useSnapshots.getState().addSnapshot(result.snapshot);
      setOutput(book.id, slot, { result, sql, start: 0 });
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
      <SqlEditor
        sql={cell.sql}
        label={cell.name + ' SQL'}
        hint={t.placeholder}
        sources={sources}
        language={language}
        onChange={update}
        onRun={(sql) => void run(false, sql)}
      />
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
          <QueryTable label={cell.name} columns={result.columns} rows={result.rows.map(row => row.slice(1))} start={start} />
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
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [words, setWords] = useState<SqlVocabulary | null>(null);
  const language = useMemo(() => notebookLanguage(sources, words, t), [sources, words, t]);
  useEffect(() => {
    let current = true;
    loadVocabulary()
      .then((value) => {
        if (current) setWords(value);
      })
      .catch((e) => {
        if (current) toast('error', String(e));
      });
    return () => {
      current = false;
    };
  }, [toast]);
  const [exporting, setExporting] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const focusNewCell = useRef(false);
  useLayoutEffect(() => {
    if (!focusNewCell.current) return;
    focusNewCell.current = false;
    list.current?.querySelector<HTMLElement>('.sql-cell:last-of-type .cm-content')?.focus();
  }, [book?.id, book?.cells.length]);

  useEffect(() => {
    let current = true;
    request('notebookSources', {})
      .then((tables) => {
        if (current) setSources(tables);
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
          <SqlCell key={cell.slot} book={book} cell={cell} sources={sources} language={language} />
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
