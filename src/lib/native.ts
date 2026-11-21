import { Channel, invoke } from '@tauri-apps/api/core';
import { useDiagnostics, type DiagnosticStatement } from '../store/diagnostics';
import { getMessages } from '../i18n';
import type { DatasetMeta } from '../types/dataset';
import type { FilterModel, SortModel } from '../types/filters';
import type { SnapshotMeta } from '../types/snapshot';

import type { Notebook, NotebookSource, SqlVocabulary, StoredNotebook, QueryResult } from '../types/notebook';

export interface Aggregate {
  sum: string | null;
  avg: string | null;
  count: number;
}
interface Catalog {
  datasets: DatasetMeta[];
  snapshots: SnapshotMeta[];
  failed: string[];
}
type ById = { id: string };
type Filtered = ById & { filters: FilterModel };
interface Commands {
  restore: [{}, { persistent: boolean; catalog: Catalog; notebooks: StoredNotebook[] }];
  createNotebook: [{ cellName: string }, StoredNotebook];
  createNotebookDraft: [{ draft: Pick<Notebook, 'name' | 'cells'> }, StoredNotebook];
  saveNotebook: [{ book: Notebook }, void];
  openNotebook: [{ path: string }, StoredNotebook];
  exportNotebook: [ById & { path: string }, void];
  deleteNotebook: [ById, void];
  sqlVocabulary: [{}, SqlVocabulary];
  notebookSources: [{}, NotebookSource[]];
  runNotebook: [ById & { cell: number; sql: string; snapshot: boolean }, QueryResult];
  notebookPage: [ById & { cell: number; start: number }, QueryResult['rows']];
  diskSpace: [{}, number | null];
  fileSize: [{ path: string }, number];
  open: [{ path: string }, DatasetMeta];
  describe: [ById, DatasetMeta];
  remove: [ById, void];
  rename: [ById & { name: string }, void];
  count: [Filtered, number];
  page: [
    Filtered & { sort: SortModel; columns: string[]; start: number; limit: number },
    (string | null)[][],
  ];
  distinct: [Filtered & { column: string; limited: boolean }, (string | null)[]];
  aggregate: [Filtered & { column: string }, Aggregate];
  snapshot: [Filtered & { sort: SortModel; columns: string[]; description: string }, SnapshotMeta];
  clipboard: [ById, string];
  export: [ById & { path: string }, void];
}

// Browser previews and older backends can send plain SQL without parameter metadata.
function diagnosticStatement(statement: DiagnosticStatement | string): DiagnosticStatement {
  return typeof statement === 'string' ? { sql: statement } : statement;
}

let trace = false;
Object.assign(globalThis, {
  sqlLog: (on = true) => {
    trace = Boolean(on);
  },
});

type Activity = { token: string; label: string; started: number };
let current: Activity | null = null;
const listeners = new Set<() => void>();
export const getActivity = () => current;
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function change(activity: Activity | null) {
  current = activity;
  for (const fn of listeners) fn();
}

// Serialize GUI operations so the progress indicator always cancels the operation it displays.
let queue: Promise<unknown> = Promise.resolve();
export const waitForRequests = () => queue;
export function request<K extends keyof Commands>(
  type: K,
  args: Commands[K][0],
): Promise<Commands[K][1]> {
  const pending = queue.then(async () => {
    const token = crypto.randomUUID();
    change({
      token,
      label: type === 'open' ? getMessages().activity.importing : getMessages().activity.query,
      started: Date.now(),
    });
    const diagnostics = useDiagnostics.getState();
    const recording = diagnostics.enabled && type !== 'diskSpace' && type !== 'fileSize';
    const consoleTrace = trace;
    const started = performance.now();
    let elapsedMs: number | undefined;
    let statements: DiagnosticStatement[] = [];
    let error: string | undefined;
    try {
      if (recording) {
        diagnostics.begin({ token, operation: type, sql: 'sql' in args ? args.sql : undefined, started: Date.now() });
      }
      const input = { request: { type, ...args }, token };
      if (!recording && !consoleTrace) return await invoke<Commands[K][1]>('ledger_request', input);
      const onStatement = recording ? new Channel<DiagnosticStatement | string>((stmt) => diagnostics.statement(token, diagnosticStatement(stmt))) : undefined;
      const report = await invoke<{
        result: Commands[K][1];
        error?: string;
        queries: (DiagnosticStatement | string)[];
        elapsedMs: number;
      }>('ledger_request', { ...input, trace: true, onStatement });
      elapsedMs = report.elapsedMs;
      statements = report.queries.map(diagnosticStatement);
      const count = Array.isArray(report.result)
        ? report.result.length
        : Number(report.result != null);
      if (consoleTrace) console.log(
        'DuckDB',
        type,
        report.elapsedMs.toFixed(1) + ' ms',
        count + ' results',
        report.queries,
      );
      if (report.error) throw new Error(report.error);
      return report.result;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      if (recording) diagnostics.finish(token, elapsedMs ?? performance.now() - started, statements, error);
      change(null);
    }
  });
  queue = pending.catch(() => undefined);
  return pending;
}
export const cancelQuery = (token: string) => invoke<void>('cancel_query', { token });
