import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Notebook } from '../types/notebook';
import {
  appendCell,
  deleteCell,
  setOutput,
  updateCell,
  editNotebook,
  flushNotebook,
  restoreNotebooks,
  selectNotebook,
  useNotebooks,
} from './notebooks';
import { request } from '../lib/native';

vi.mock('../lib/native', () => ({ request: vi.fn() }));
const book: Notebook = { id: 'one', name: 'SQL 1', cells: [{ slot: 0, name: 'Query 1', sql: '' }] };
const key = 'ledgerview.notebook.pending.one';
const withSql = (sql: string): Notebook => ({
  ...book,
  cells: [{ slot: 0, name: 'Query 1', sql }],
});
describe('notebook autosave', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
      removeItem: (k: string) => data.delete(k),
    });
    vi.useFakeTimers();
    vi.mocked(request).mockReset().mockResolvedValue(undefined);
    useNotebooks.setState({ saves: {}, outputs: {} });
    restoreNotebooks([book], true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('restores the last edit made before closing during the debounce', async () => {
    editNotebook(withSql('SELECT 7'));
    expect(request).not.toHaveBeenCalled();
    restoreNotebooks([book], true);
    expect(useNotebooks.getState().books[0]).toEqual(withSql('SELECT 7'));
    await vi.advanceTimersByTimeAsync(400);
    expect(request).toHaveBeenCalledWith('saveNotebook', { book: withSql('SELECT 7') });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('saves newer edits even when an older save finishes after switching books', async () => {
    let finish!: () => void;
    vi.mocked(request).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    editNotebook(withSql('SELECT 1'));
    const first = flushNotebook(book.id);
    editNotebook(withSql('SELECT 2'));
    selectNotebook(null);
    finish();
    await first;
    expect(request).toHaveBeenLastCalledWith('saveNotebook', { book: withSql('SELECT 2') });
    expect(useNotebooks.getState().saves.one).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('keeps cell identity across edits, deletions and late query responses', async () => {
    restoreNotebooks(
      [
        {
          ...book,
          cells: [
            { name: 'A', sql: 'SELECT 1' },
            { name: 'B', sql: 'SELECT 2' },
          ],
        },
      ],
      true,
    );
    const current = () => useNotebooks.getState().books[0];
    setOutput(book.id, 1, { sql: 'SELECT 2' });
    deleteCell(book.id, 0);
    updateCell(book.id, 1, { name: 'Report' });
    appendCell(current(), 'Query');
    expect(current().cells.map((c) => c.name)).toEqual(['Report', 'Query 2']);
    expect(current().cells[1].slot).toBeGreaterThan(1);
    setOutput(book.id, 0, { error: 'late' });
    expect(useNotebooks.getState().outputs).toEqual({ 'one/1': { sql: 'SELECT 2' } });
    await flushNotebook(book.id);
    expect(request).toHaveBeenLastCalledWith('saveNotebook', { book: current() });
  });

  it('retains a failed save for retry and treats memory mode as session-only', async () => {
    editNotebook(withSql('SELECT 3'));
    vi.mocked(request).mockRejectedValueOnce(Error('Disk full'));
    await expect(flushNotebook(book.id)).rejects.toThrow('Disk full');
    expect(useNotebooks.getState().saves.one).toBe('failed');
    expect(localStorage.getItem(key)).toContain('SELECT 3');
    await flushNotebook(book.id);
    expect(localStorage.getItem(key)).toBeNull();
    restoreNotebooks([book], false);
    editNotebook(withSql('SELECT 4'));
    expect(localStorage.getItem(key)).toBeNull();
    await flushNotebook(book.id);
  });
});
