import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  themeQuartz,
  type CellContextMenuEvent,
  type GridApi,
  type GridReadyEvent,
} from 'ag-grid-community';
import { type DatasetMeta } from '../../types/dataset';
import type { ColumnFilter, FilterModel } from '../../types/filters';
import { buildColumnDefs } from './columnDefs';
import { makeDatasource } from './datasource';
import { CellContextMenu, type CellMenuState } from './CellContextMenu';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { request } from '../../lib/native';
import { useUi } from '../../store/ui';
import { useGridLocale, useMessages } from '../../i18n';

// 品牌風格：白底、黑字、細灰框、橘色 accent（選取/focus）、橘色淡 tint 作 hover。
const lvTheme = themeQuartz.withParams({
  accentColor: '#FD5108',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#000000',
  borderColor: '#DFE3E6',
  chromeBackgroundColor: '#F5F7F8',
  headerTextColor: '#000000',
  headerFontWeight: 600,
  rowHoverColor: '#FFF5ED',
  selectedRowBackgroundColor: '#FFE8D4',
  oddRowBackgroundColor: '#FFFFFF',
  fontFamily:
    "'IBM Plex Sans', system-ui, -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
  fontSize: 13,
  headerFontSize: 13,
  spacing: 6,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
});

const defaultColDef = {
  sortable: true,
  resizable: true,
  filter: true,
  floatingFilter: false,
};

interface Props {
  dataset: DatasetMeta;
  onFilteredCount: (n: number) => void;
  onApiReady?: (api: GridApi) => void;
  onFilterModelChange?: (model: Record<string, unknown>) => void;
}

export function LedgerGrid({ dataset, onFilteredCount, onApiReady, onFilterModelChange }: Props) {
  const t = useMessages();
  const gridLocale = useGridLocale();
  const toast = useUi((s) => s.toast);
  const rowHeight = useUi((s) => s.rowHeight);
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const [menu, setMenu] = useState<CellMenuState | null>(null);

  const { id, rowKey, rowCount, columns, hiddenColumns } = dataset;
  const columnDefs = useMemo(() => buildColumnDefs({ id, rowKey, columns }), [id, rowKey, columns]);
  // Update visibility on the existing columns so active filters and sorting stay attached.
  useEffect(() => {
    if (!gridApi) return;
    const hidden = new Set(hiddenColumns);
    const changes = gridApi
      .getColumnState()
      .filter((c) => Boolean(c.hide) !== hidden.has(c.colId))
      .map(({ colId }) => ({ colId, hide: hidden.has(colId) }));
    if (changes.length) gridApi.applyColumnState({ state: changes });
  }, [gridApi, hiddenColumns]);

  const datasource = useMemo(
    () =>
      makeDatasource(
        { id, rowKey, rowCount },
        {
          onError: (msg) => toast('error', t.grid.queryFailed(msg)),
          onCount: (n) => onFilteredCount(n),
        },
      ),
    [id, rowKey, rowCount, toast, onFilteredCount, t],
  );

  // datasource 以 prop 提供即可，這裡只負責把 API 交給上層（供讀取 filter/sort）。
  const onGridReady = (e: GridReadyEvent) => {
    setGridApi(e.api);
    onApiReady?.(e.api);
  };

  // 右鍵：自訂選單（Community 無 getContextMenuItems）。列號欄不顯示選單。
  const onCellContextMenu = useCallback(
    (e: CellContextMenuEvent) => {
      const colId = e.column?.getColId();
      if (!colId || colId === dataset.rowKey) return;
      const me = e.event as MouseEvent | null;
      me?.preventDefault();
      setMenu({ x: me?.clientX ?? 0, y: me?.clientY ?? 0, colId, value: e.value });
    },
    [dataset.rowKey],
  );

  const onCopy = useCallback(() => {
    if (!menu) return;
    void writeText(String(menu.value ?? '')).then(
      () => toast('success', t.grid.copied),
      () => toast('error', t.grid.copyFailed),
    );
    setMenu(null);
  }, [menu, toast, t]);

  // 複製整欄去重後的值為 JSON 陣列 {selected:[...]}（供另一欄「改用已複製的陣列篩選」貼上）。
  const onCopyArray = useCallback(() => {
    const api = gridApi;
    if (!menu || !api) return;
    const col = dataset.columns.find((c) => c.name === menu.colId);
    if (!col) {
      setMenu(null);
      return;
    }
    const fm = (api.getFilterModel() ?? {}) as FilterModel;
    void (async () => {
      try {
        // 不帶 limit：完整複製整欄去重值（已套用目前各欄篩選 fm）。
        const result = await request('distinct', {
          id: dataset.id,
          column: col.name,
          filters: fm,
          limited: false,
        });
        const values = result.filter((v): v is string => v !== null);
        await writeText(JSON.stringify({ selected: values }));
        toast('success', t.grid.copiedArray(values.length));
      } catch {
        toast('error', t.grid.copyArrayFailed);
      }
    })();
    setMenu(null);
  }, [menu, gridApi, dataset, toast, t]);

  // 以該儲存格的值篩選該欄（依欄型別產生對應的 filter model，與該欄註冊的篩選器一致）。
  const onFilter = useCallback(() => {
    const api = gridApi;
    if (!menu || !api) return;
    const col = dataset.columns.find((c) => c.name === menu.colId);
    const v = menu.value;
    let cond: ColumnFilter;
    if (col?.displayType === 'number') {
      cond =
        v == null
          ? { filterType: 'number', type: 'blank' }
          : { filterType: 'number', type: 'equals', filter: String(v) };
    } else if (col?.displayType === 'date' || col?.displayType === 'datetime') {
      cond =
        v == null
          ? { filterType: 'date', type: 'blank' }
          : { filterType: 'date', type: 'equals', dateFrom: String(v).slice(0, 10) };
    } else if (col?.displayType === 'boolean') {
      // boolean 僅清單模式：產生 set 條件，重開篩選器才會落在清單並反映勾選。
      cond =
        v == null
          ? { filterType: 'set', values: [], includeBlanks: true }
          : { filterType: 'set', values: [String(v)], includeBlanks: false };
    } else {
      // 文字欄：以「等於該值」篩選（對齊數字/日期的等於；開窗會落在文字模式）。
      cond =
        v == null
          ? { filterType: 'text', type: 'blank' }
          : { filterType: 'text', type: 'equals', filter: String(v) };
    }
    const current = (api.getFilterModel() ?? {}) as Record<string, unknown>;
    api.setFilterModel({ ...current, [menu.colId]: cond });
    setMenu(null);
  }, [menu, gridApi, dataset.columns]);

  // 行距：執行期改變列高。setGridOption 為決定性重排；均一列高無需 resetRowHeights。
  useEffect(() => {
    gridApi?.setGridOption('rowHeight', rowHeight);
  }, [gridApi, rowHeight]);

  return (
    <div className="grid-wrap">
      <AgGridReact
        theme={lvTheme}
        suppressFieldDotNotation
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        rowModelType="infinite"
        datasource={datasource}
        headerHeight={40}
        rowHeight={rowHeight}
        cacheBlockSize={200}
        maxConcurrentDatasourceRequests={1}
        maxBlocksInCache={60}
        infiniteInitialRowCount={1}
        blockLoadDebounceMillis={60}
        rowBuffer={10}
        localeText={gridLocale}
        onGridReady={onGridReady}
        onColumnVisible={(e) => {
          // Cached pages can lack newly shown fields. Refresh in place to retain scroll and rows.
          if (e.visible !== false) e.api.refreshInfiniteCache();
        }}
        onFilterChanged={(e) => onFilterModelChange?.(e.api.getFilterModel())}
        onCellContextMenu={onCellContextMenu}
        preventDefaultOnContextMenu
        suppressMenuHide={false}
      />
      {menu && (
        <CellContextMenu
          menu={menu}
          onCopy={onCopy}
          onCopyArray={onCopyArray}
          showCopyArray={dataset.columns.find((c) => c.name === menu.colId)?.displayType === 'text'}
          onFilter={onFilter}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
