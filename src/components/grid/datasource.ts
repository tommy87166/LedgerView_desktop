import type { IDatasource } from 'ag-grid-community';
import type { DatasetMeta } from '../../types/dataset';
import type { FilterModel } from '../../types/filters';
import { request } from '../../lib/native';

export function makeDatasource(
  ds: Pick<DatasetMeta, 'id' | 'rowKey' | 'rowCount'>,
  hooks: { onCount(n: number): void; onError(msg: string): void },
): IDatasource {
  const counts = new Map<string, number>([['{}', ds.rowCount]]);
  let destroyed = false;
  return {
    destroy() {
      destroyed = true;
    },
    async getRows(params) {
      // Even discarded requests must settle so AG Grid releases its block-loading slot.
      if (destroyed) return params.failCallback();
      const filters = (params.filterModel ?? {}) as FilterModel;
      const args = { id: ds.id, filters };
      const key = JSON.stringify(filters);
      try {
        let total = counts.get(key);
        if (total === undefined) {
          total = await request('count', args);
          counts.set(key, total);
        }
        if (destroyed) return params.failCallback();
        hooks.onCount(total);
        const columns = params.api
          .getAllDisplayedColumns()
          .map((c) => c.getColId())
          .filter((id) => id !== ds.rowKey);
        const rows = await request('page', {
          ...args,
          sort: params.sortModel,
          columns,
          start: params.startRow,
          limit: params.endRow - params.startRow,
        });
        if (destroyed) return params.failCallback();
        const keys = [ds.rowKey, ...columns];
        params.successCallback(
          rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i]]))),
          total,
        );
      } catch (e) {
        if (!destroyed) hooks.onError(String(e));
        params.failCallback();
      }
    },
  };
}
