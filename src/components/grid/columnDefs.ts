import type { ColDef } from 'ag-grid-community';
import { type ColumnMeta, type DatasetMeta } from '../../types/dataset';
import { TextColumnFilter } from './filters/TextColumnFilter';

import { formatNumber } from '../../lib/numbers';
import { NumberColumnFilter } from './filters/NumberColumnFilter';

/** 將欄位 meta 轉為 AG Grid ColDef。文字欄掛 TextColumnFilter（清單＋文字運算子）。 */
export function buildColumnDefs(dataset: Pick<DatasetMeta, 'id' | 'rowKey' | 'columns'>): ColDef[] {
  // 列號欄（固定原始序號）：釘左、不可隱藏／排序／篩選／移動。
  const rowNumberCol: ColDef = {
    colId: dataset.rowKey,
    headerName: '#',
    valueGetter: (p) => {
      const rn = (p.data as Record<string, unknown> | undefined)?.[dataset.rowKey];
      return rn == null ? '' : Number(rn) + 1; // 0-based → 1-based 顯示
    },
    pinned: 'left',
    lockPinned: true,
    lockPosition: true,
    lockVisible: true,
    suppressMovable: true,
    sortable: false,
    filter: false,
    resizable: true,
    width: 72,
    minWidth: 52,
    cellClass: 'lv-rownum',
    headerClass: 'lv-rownum',
  };
  const userCols = dataset.columns.map((c) => {
    const def: ColDef = {
      colId: c.name,
      field: c.name,
      cellDataType: false,
      headerName: c.name,
      sortable: true,
      resizable: true,
      minWidth: 90,
      headerTooltip: `${c.name}（${c.duckdbType}）`,
    };
    if (c.displayType === 'number') {
      def.type = 'numericColumn';
      def.filter = NumberColumnFilter;
      def.valueFormatter = (p) => (p.value == null || p.value === '' ? '' : formatNumber(p.value));
    } else if (c.displayType === 'date' || c.displayType === 'datetime') {
      def.filter = 'agDateColumnFilter';
    } else {
      // 文字欄：整合「清單（仿 Excel 勾選）＋ 文字運算子」雙模式篩選器。
      // columnMeta 不可命名為 column，會與 AG Grid 內建 column 參數衝突。
      def.filter = TextColumnFilter;
      def.filterParams = { datasetId: dataset.id, columnMeta: c } satisfies {
        datasetId: string;
        columnMeta: ColumnMeta;
      };
    }
    return def;
  });
  return [rowNumberCol, ...userCols];
}
