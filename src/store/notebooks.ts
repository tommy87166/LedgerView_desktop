import { create } from 'zustand';
import { request } from '../lib/native';
import { useDatasets } from './datasets';
import type { Notebook, StoredNotebook, SqlCell, QueryResult } from '../types/notebook';

interface CellOutput {
  busy?: boolean;
  error?: string;
  sql?: string;
  result?: QueryResult;
  start?: number;
}
interface State {
  books: Notebook[];
  activeId: string | null;
  editing: boolean;
  saves: Record<string, 'saving' | 'failed' | undefined>;
  outputs: Record<string, CellOutput>;
}
export const useNotebooks = create<State>(() => ({
  books: [],
  activeId: null,
  editing: false,
  saves: {},
  outputs: {},
}));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const saving = new Map<string, Promise<void>>();
let persistent = false;
const journalKey = (id: string) => 'ledgerview.notebook.pending.' + id;

function setSaveStatus(id: string, status: State['saves'][string]) {
  useNotebooks.setState((s) => ({ saves: { ...s.saves, [id]: status } }));
}

let nextSlot = 0;
function loadNotebook(stored: StoredNotebook): Notebook {
  const cells = stored.cells.map((cell, i) => {
    const slot = cell.slot ?? i;
    nextSlot = Math.max(nextSlot, slot + 1);
    return { ...cell, slot };
  });
  return { ...stored, cells };
}

export function appendCell(book: Notebook, label: string) {
  const names = new Set(book.cells.map((c) => c.name));
  let n = book.cells.length + 1;
  while (names.has(label + ' ' + n)) n++;
  editNotebook({
    ...book,
    cells: [...book.cells, { slot: nextSlot++, name: label + ' ' + n, sql: '' }],
  });
}

export function updateCell(
  id: string,
  slot: number,
  patch: Partial<Pick<SqlCell, 'name' | 'sql'>>,
) {
  const book = useNotebooks.getState().books.find((b) => b.id === id);
  if (book)
    editNotebook({
      ...book,
      cells: book.cells.map((c) => (c.slot === slot ? { ...c, ...patch } : c)),
    });
}

export function deleteCell(id: string, slot: number) {
  const book = useNotebooks.getState().books.find((b) => b.id === id);
  if (!book?.cells.some((c) => c.slot === slot)) return;
  editNotebook({ ...book, cells: book.cells.filter((c) => c.slot !== slot) });
  useNotebooks.setState((s) => {
    const outputs = { ...s.outputs };
    delete outputs[id + '/' + slot];
    return { outputs };
  });
}

export function restoreNotebooks(stored: StoredNotebook[], disk: boolean) {
  const books = stored.map(loadNotebook);
  persistent = disk;
  useNotebooks.setState({
    books,
    activeId: books[0]?.id ?? null,
    editing: books.length > 0 && !useDatasets.getState().activeId,
  });
  // A window can close during the debounce or while DuckDB is running another query.
  if (disk)
    for (const book of books) {
      try {
        const raw = localStorage.getItem(journalKey(book.id));
        if (!raw) continue;
        const draft: StoredNotebook = JSON.parse(raw);
        if (
          draft.id === book.id &&
          typeof draft.name === 'string' &&
          Array.isArray(draft.cells) &&
          draft.cells.every((c) => typeof c?.sql === 'string' && typeof c.name === 'string')
        )
          editNotebook(loadNotebook(draft));
      } catch {
        /* Native storage still works when web storage is unavailable. */
      }
    }
}

export function selectNotebook(id: string | null) {
  useDatasets.getState().setActive(null);
  useNotebooks.setState({ activeId: id, editing: true });
}
useDatasets.subscribe((next, prev) => {
  if (next.activeId && next.activeId !== prev.activeId) useNotebooks.setState({ editing: false });
});

export function addNotebook(stored: StoredNotebook) {
  const book = loadNotebook(stored);
  useNotebooks.setState((s) => ({ books: [...s.books, book] }));
  selectNotebook(book.id);
}

export function editNotebook(book: Notebook) {
  if (persistent) {
    try {
      localStorage.setItem(journalKey(book.id), JSON.stringify(book));
    } catch {
      /* Save through DuckDB. */
    }
  }
  useNotebooks.setState((s) => ({
    books: s.books.map((b) => (b.id === book.id ? book : b)),
    saves: { ...s.saves, [book.id]: 'saving' },
  }));
  clearTimeout(timers.get(book.id));
  timers.set(
    book.id,
    setTimeout(() => {
      void flushNotebook(book.id).catch(() => {});
    }, 350),
  );
}

export async function flushNotebook(id: string): Promise<void> {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const pending = saving.get(id);
  if (pending) {
    await pending;
    return flushNotebook(id);
  }
  const state = useNotebooks.getState();
  const book = state.books.find((b) => b.id === id);
  if (!book || !state.saves[id]) return;
  setSaveStatus(id, 'saving');
  const job = request('saveNotebook', { book })
    .then(() => {
      if (useNotebooks.getState().books.find((b) => b.id === id) === book) {
        setSaveStatus(id, undefined);
        if (persistent) {
          try {
            localStorage.removeItem(journalKey(id));
          } catch {
            /* Already saved in DuckDB. */
          }
        }
      }
    })
    .catch((error) => {
      setSaveStatus(id, 'failed');
      throw error;
    })
    .finally(() => saving.delete(id));
  saving.set(id, job);
  await job;
  if (useNotebooks.getState().saves[id] === 'saving') await flushNotebook(id);
}

export async function deleteNotebook(id: string) {
  await request('deleteNotebook', { id });
  clearTimeout(timers.get(id));
  timers.delete(id);
  try {
    localStorage.removeItem(journalKey(id));
  } catch {
    /* Web storage unavailable. */
  }
  useNotebooks.setState((s) => {
    const books = s.books.filter((b) => b.id !== id);
    const saves = { ...s.saves };
    delete saves[id];
    const outputs = Object.fromEntries(
      Object.entries(s.outputs).filter(([key]) => !key.startsWith(id + '/')),
    );
    return {
      books,
      saves,
      outputs,
      activeId: s.activeId === id ? (books[0]?.id ?? null) : s.activeId,
    };
  });
}

export function setOutput(id: string, cell: number, output: CellOutput) {
  const key = id + '/' + cell;
  useNotebooks.setState((s) =>
    s.books.find((b) => b.id === id)?.cells.some((c) => c.slot === cell)
      ? { outputs: { ...s.outputs, [key]: output } }
      : s,
  );
}
