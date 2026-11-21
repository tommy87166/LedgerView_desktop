import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Notebook } from '../types/notebook';
import {
  appendCell,
  applyAiNotebook,
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

  it('lets a newer autosave continue after a pending write fails', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(request).mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    editNotebook(withSql('SELECT 1'));
    const first = expect(flushNotebook(book.id)).rejects.toThrow('disk');
    editNotebook(withSql('SELECT 2'));
    await vi.advanceTimersByTimeAsync(350);
    reject(Error('disk'));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenLastCalledWith('saveNotebook', { book: withSql('SELECT 2') });
    expect(useNotebooks.getState().saves.one).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('reports an applied AI edit as pending and preserves the draft on disk errors', async () => {
    vi.mocked(request).mockRejectedValueOnce(Error('disk'));
    const edited = withSql('SELECT 3');
    expect(await applyAiNotebook(book, book.name, edited.cells)).toMatchObject({
      id: book.id, applied: true, saveStatus: 'pending',
    });
    expect(useNotebooks.getState().books[0]).toEqual(edited);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(edited);
    await flushNotebook(book.id);
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

  it('rejects an AI edit against a pending local draft', async () => {
    editNotebook(withSql('SELECT 10'));
    await expect(applyAiNotebook(book, 'AI', [])).rejects.toThrow('changed');
    expect(useNotebooks.getState().books[0]).toEqual(withSql('SELECT 10'));
    expect(request).not.toHaveBeenCalled();
  });

  it('creates an AI notebook atomically and leaves the active notebook selected', async () => {
    selectNotebook(book.id);
    vi.mocked(request).mockResolvedValueOnce({ id: 'new', name: 'Created', cells: [] });
    expect(await applyAiNotebook(null, 'Created', [])).toEqual({ id: 'new' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('createNotebookDraft', { draft: { name: 'Created', cells: [] } });
    expect(useNotebooks.getState().activeId).toBe(book.id);
  });

  it('persists AI notebook edits using stable slots and leaves edited SQL unexecuted', async () => {
    await applyAiNotebook(book, 'Review', [{ slot: 0, name: 'Total', sql: 'SELECT 7' }, { name: 'Details', sql: 'SELECT 8' }]);
    const saved = useNotebooks.getState().books[0];
    expect(saved.cells[0]).toEqual({ slot: 0, name: 'Total', sql: 'SELECT 7' });
    expect(saved.cells[1].slot).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('saveNotebook', { book: saved });
    await expect(applyAiNotebook(saved, 'Review', [saved.cells[0], saved.cells[0]])).rejects.toThrow('repeated');
    await applyAiNotebook(saved, 'Review', [saved.cells[1]]);
    expect(useNotebooks.getState().books[0].cells).toEqual([saved.cells[1]]);
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
