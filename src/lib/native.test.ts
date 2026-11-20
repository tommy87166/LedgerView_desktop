import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useDiagnostics, type DiagnosticStatement } from '../store/diagnostics';
import { getActivity, request } from './native';

// Keep the request queue and diagnostics store real. Only replace the desktop transport.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (statement: DiagnosticStatement | string) => void) {}
  },
}));

const ipc = vi.mocked(invoke);
const log = useDiagnostics.getState;
const count = () => request('count', {
  id: 'ledger',
  filters: { sample_label: { filterType: 'text', type: 'equals', filter: "demo'item?" } },
});
const statement = { sql: 'SELECT count(*) FROM ledger WHERE lower(sample_label) = lower(?)', params: ["demo'item?"] };

beforeEach(() => {
  ipc.mockReset();
  log().setEnabled(true);
});

it('records the live bound value and replaces it with the final DuckDB report and duration', async () => {
  ipc.mockImplementationOnce(async (_command, args) => {
    const { token, onStatement } = args as { token: string; onStatement: { onmessage: (s: DiagnosticStatement) => void } };
    expect(getActivity()?.token).toBe(token);
    onStatement.onmessage(statement);
    expect(log().entries[0]).toMatchObject({ token, operation: 'count', currentStatement: statement });
    expect(log().entries[0].elapsedMs).toBeUndefined();
    return { result: 2, elapsedMs: 12.5, queries: ['BEGIN', statement] };
  });
  expect(await count()).toBe(2);
  expect(log().entries).toHaveLength(1);
  expect(log().entries[0]).toMatchObject({ elapsedMs: 12.5, statements: [{ sql: 'BEGIN' }, statement] });
  expect(getActivity()).toBeNull();
});

it('keeps a failed query and runs the next queued request with its own result', async () => {
  ipc.mockResolvedValueOnce({ error: 'Binder Error: missing column', elapsedMs: 3, queries: ['SELECT missing'] });
  ipc.mockResolvedValueOnce({ result: 2, elapsedMs: 8, queries: [statement] });
  const failed = request('runNotebook', { id: 'book', cell: 0, sql: 'SELECT missing', snapshot: false });
  const next = count();
  await expect(failed).rejects.toThrow('Binder Error: missing column');
  expect(await next).toBe(2);
  expect(log().entries).toMatchObject([
    { operation: 'count', elapsedMs: 8, statements: [statement] },
    { sql: 'SELECT missing', error: 'Binder Error: missing column', elapsedMs: 3, statements: [{ sql: 'SELECT missing' }] },
  ]);
});

it('records IPC failures even when the worker cannot return a report', async () => {
  ipc.mockRejectedValueOnce('Database unavailable');
  await expect(count()).rejects.toBe('Database unavailable');
  expect(log().entries[0]).toMatchObject({ error: 'Database unavailable', elapsedMs: expect.any(Number) });
  expect(getActivity()).toBeNull();
});

it('uses ordinary IPC with logging off and skips tracing disk-space checks with logging on', async () => {
  log().setEnabled(false);
  ipc.mockResolvedValueOnce(2).mockResolvedValueOnce(1024);
  expect(await count()).toBe(2);
  log().setEnabled(true);
  expect(await request('diskSpace', {})).toBe(1024);
  for (const [command, input] of ipc.mock.calls) {
    expect(command).toBe('ledger_request');
    expect(input).not.toHaveProperty('trace');
    expect(input).not.toHaveProperty('onStatement');
  }
  expect(log().entries).toEqual([]);
});

it('does not restore cleared SQL or bound values if an old request reports after logging is re-enabled', async () => {
  ipc.mockImplementationOnce(async (_command, args) => {
    const { onStatement } = args as { onStatement: { onmessage: (s: DiagnosticStatement) => void } };
    onStatement.onmessage(statement);
    log().setEnabled(false);
    log().setEnabled(true);
    onStatement.onmessage(statement);
    return { result: 2, elapsedMs: 4, queries: [statement] };
  });
  expect(await count()).toBe(2);
  expect(log().entries).toEqual([]);
});
