import type { GridApi, IGetRowsParams } from 'ag-grid-community';
import { beforeEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/native';
import { makeDatasource } from './datasource';

vi.mock('../../lib/native', () => ({ request: vi.fn() }));
const fetch = vi.mocked(request);
beforeEach(() => fetch.mockReset());

const dataset = { id: 'ledger', rowKey: '__index', rowCount: 10 };
function setup() {
  const hooks = { onCount: vi.fn(), onError: vi.fn() };
  const names = ['__index', 'amount'];
  const params: IGetRowsParams = {
    api: {
      getAllDisplayedColumns: () => names.map((name) => ({ getColId: () => name })),
    } as GridApi,
    startRow: 0,
    endRow: 10,
    sortModel: [],
    filterModel: {},
    context: undefined,
    successCallback: vi.fn(),
    failCallback: vi.fn(),
  };
  return { source: makeDatasource(dataset, hooks), params, hooks, names };
}

it('releases a pending block when the datasource is destroyed during a page read', async () => {
  const { source, params, hooks } = setup();
  let deliver!: (rows: string[][]) => void;
  fetch.mockReturnValueOnce(
    new Promise<string[][]>((resolve) => {
      deliver = resolve;
    }),
  );
  const loading = source.getRows(params);
  expect(fetch).toHaveBeenCalledWith('page', expect.anything());
  source.destroy!();
  deliver([['0', '40']]);
  await loading;
  expect(params.failCallback).toHaveBeenCalledTimes(1);
  expect(params.successCallback).not.toHaveBeenCalled();
  expect(hooks.onError).not.toHaveBeenCalled();
});

it('settles a discarded count without starting a page read', async () => {
  const { source, params, hooks } = setup();
  params.filterModel = { amount: { filterType: 'number', type: 'equals', filter: 40 } };
  fetch.mockResolvedValueOnce(1);
  const loading = source.getRows(params);
  source.destroy!();
  await loading;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(params.failCallback).toHaveBeenCalledTimes(1);
  expect(params.successCallback).not.toHaveBeenCalled();
  expect(hooks.onCount).not.toHaveBeenCalled();
});

it('reads the current visible fields for every block, including when only the row number is visible', async () => {
  const { source, params, names } = setup();
  names.pop();
  fetch.mockResolvedValueOnce([['0']]);
  await source.getRows(params);
  expect(fetch).toHaveBeenLastCalledWith('page', expect.objectContaining({ columns: [] }));
  expect(params.successCallback).toHaveBeenLastCalledWith([{ __index: '0' }], 10);
  names.push('memo', 'amount');
  fetch.mockResolvedValueOnce([['0', 'payment', '40']]);
  await source.getRows(params);
  expect(fetch).toHaveBeenLastCalledWith(
    'page',
    expect.objectContaining({ columns: ['memo', 'amount'] }),
  );
  expect(params.successCallback).toHaveBeenLastCalledWith(
    [{ __index: '0', memo: 'payment', amount: '40' }],
    10,
  );
});
