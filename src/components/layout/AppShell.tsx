import { useCallback, useEffect, useRef, useState } from 'react';
import type { GridApi } from 'ag-grid-community';
import { useDatasets } from '../../store/datasets';
import { useSnapshots } from '../../store/snapshots';
import { useUi } from '../../store/ui';
import { useImportManager } from '../../hooks/useImportManager';
import { LedgerGrid } from '../grid/LedgerGrid';
import { ColumnPicker } from '../grid/ColumnPicker';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { confirm } from '@tauri-apps/plugin-dialog';
import {
  IconDatabase,
  IconSnapshot,
  IconColumns,
  IconClearFilter,
} from '../common/icons';
import { request, type Aggregate } from '../../lib/native';
import { formatNumber, exactAverage } from '../../lib/numbers';
import { describeFilters } from '../../lib/describeFilter';
import { useLang, useMessages } from '../../i18n';
import type { SnapshotMeta } from '../../types/snapshot';
import type { FilterModel, SortModel } from '../../types/filters';

import { NotebookWorkspace } from '../notebooks/NotebookWorkspace';
import { useNotebooks } from '../../store/notebooks';

export function AppShell() {
  const t = useMessages();
  const lang = useLang();
  const notebookMode = useNotebooks(s => s.editing);
  const datasets = useDatasets((s) => s.datasets);
  const activeId = useDatasets((s) => s.activeId);
  const setActive = useDatasets((s) => s.setActive);
  const addDataset = useDatasets((s) => s.addDataset);
  const removeDataset = useDatasets((s) => s.removeDataset);
  const toast = useUi((s) => s.toast);
  const addSnapshot = useSnapshots((s) => s.addSnapshot);

  const { importing, openPicker, dragOver } = useImportManager();
  const gridApiRef = useRef<GridApi | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [filterModel, setFilterModel] = useState<FilterModel>({});
  const [aggColumn, setAggColumn] = useState<string>('');
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [busy, setBusy] = useState(false);
  const [colPickerOpen, setColPickerOpen] = useState(false);

  const active = datasets.find((d) => d.id === activeId) ?? null;
  const numericColumns = active?.columns.filter((c) => c.displayType === 'number') ?? [];
  const selectedNumericColumn = numericColumns.find((column) => column.name === aggColumn);

  // 切換資料集時重置篩選彙總狀態（避免沿用前一個分頁的篩選）。
  const gridKey = JSON.stringify([activeId, active?.importedAt, lang]);
  const [currentGrid, setCurrentGrid] = useState(gridKey);
  if (currentGrid !== gridKey) {
    setCurrentGrid(gridKey);
    setAgg(null);
    setFilterModel({});
    setAggColumn('');
    setFilteredCount(null);
    setColPickerOpen(false);
  }

  // 計算選定數值欄在目前篩選下的彙總（查帳常用）。
  useEffect(() => {
    if (!activeId || !selectedNumericColumn) {
      setAgg(null);
      return;
    }
    let cancelled = false;
    setAgg(null);
    void (async () => {
      try {
        const res = await request('aggregate', {
          id: activeId,
          filters: filterModel,
          column: selectedNumericColumn.name,
        });
        if (!cancelled) setAgg(res);
      } catch {
        if (!cancelled) setAgg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, selectedNumericColumn, filterModel]);

  const onApiReady = useCallback((api: GridApi) => {
    gridApiRef.current = api;
  }, []);

  // 一鍵清除所有欄位篩選與排序（grid 會自動重查、彙總同步更新）。
  const onClearAll = useCallback(() => {
    const api = gridApiRef.current;
    if (!api) return;
    api.setFilterModel(null);
    api.applyColumnState({ defaultState: { sort: null } });
  }, []);

  const getCurrentModels = useCallback((): {
    filterModel: FilterModel;
    sortModel: SortModel;
  } => {
    const api = gridApiRef.current;
    const fm = (api?.getFilterModel() ?? {}) as FilterModel;
    const sortModel: SortModel = [];
    api
      ?.getColumnState()
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .forEach((c) => {
        if (c.sort) sortModel.push({ colId: c.colId, sort: c.sort as 'asc' | 'desc' });
      });
    return { filterModel: fm, sortModel };
  }, []);

  // 工具列「快照」：以目前篩選＋排序建立快照。
  const onCreateSnapshot = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      const { filterModel: fm, sortModel } = getCurrentModels();
      // 隱藏的欄位不納入快照。
      const hidden = new Set(active.hiddenColumns ?? []);
      const visibleColumns = active.columns.filter((c) => !hidden.has(c.name));
      const snap = await request('snapshot', {
        id: active.id,
        filters: fm,
        sort: sortModel,
        columns: visibleColumns.map((c) => c.name),
        description: describeFilters(fm),
      });
      addSnapshot(snap);
      toast('success', t.snapshot.created(snap.displayName, snap.rowCount.toLocaleString()));
    } catch (err) {
      toast('error', t.snapshot.createFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }, [active, getCurrentModels, addSnapshot, toast, t]);

  const pendingPreview = useRef<string | null>(null);
  const selectDataset = (id: string) => {
    pendingPreview.current = null;
    setActive(id);
  };

  const openSnapshot = async (snap: SnapshotMeta) => {
    if (datasets.some((d) => d.id === snap.id)) {
      selectDataset(snap.id);
      return;
    }
    pendingPreview.current = snap.id;
    try {
      const preview = await request('describe', { id: snap.id });
      if (pendingPreview.current === snap.id && useDatasets.getState().activeId === activeId) {
        addDataset(preview);
      }
    } catch (err) {
      if (pendingPreview.current === snap.id) {
        toast('error', t.snapshot.openFailed(err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const onCloseDataset = useCallback(
    async (id: string) => {
      const ds = datasets.find((d) => d.id === id);
      if (!ds) return;
      // 暫時性分頁（快照預覽）：直接移除，不刪底層表。
      if (ds.ephemeral) {
        removeDataset(id);
        return;
      }
      if (!(await confirm(t.dataset.closeConfirm(ds.displayName)))) return;
      try {
        await request('remove', { id });
        removeDataset(id);
        toast('success', t.dataset.closed(ds.displayName));
      } catch (err) {
        toast('error', t.dataset.closeFailed(err instanceof Error ? err.message : String(err)));
      }
    },
    [datasets, removeDataset, toast, t],
  );

  return (
    <div
      className="app-shell"
      style={dragOver ? { outline: '3px dashed var(--lv-accent)', outlineOffset: -3 } : undefined}
    >
      <WorkspaceSidebar
        importing={importing}
        onOpen={openPicker}
        onSelect={selectDataset}
        onClose={onCloseDataset}
        onPreview={openSnapshot}
        onNotebookNavigate={() => { pendingPreview.current = null; }}
      />
      {notebookMode && !activeId ? <NotebookWorkspace /> : <main className="table-workspace">
        <header className="table-toolbar">
          {active && (
            <div className="table-title" title={active.displayName}>
              {active.ephemeral ? <IconSnapshot /> : <IconDatabase />}
              <span>{active.displayName}</span>
              {active.ephemeral && (
                <button
                  className="quiet-button close-preview"
                  onClick={() => void onCloseDataset(active.id)}
                  aria-label={t.snapshot.closePreview}
                  title={t.snapshot.closePreview}
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div className="spacer" />
          <button
            className="btn icon-btn"
            onClick={() => void onCreateSnapshot()}
            disabled={busy || !active || active.columns.length === active.hiddenColumns?.length}
            title={t.topbar.createSnapshotTooltip}
          >
            <IconSnapshot />
            <span className="label">{t.topbar.createSnapshot}</span>
          </button>
          <div className="col-picker-wrap">
            <button
              className={`btn icon-btn ${colPickerOpen ? 'active' : ''}`}
              onClick={() => setColPickerOpen((o) => !o)}
              disabled={!active}
              aria-expanded={colPickerOpen}
              title={t.topbar.columnsTooltip}
            >
              <IconColumns />
              <span className="label">{t.topbar.columns}</span>
            </button>
            {colPickerOpen && active && (
              <ColumnPicker dataset={active} onClose={() => setColPickerOpen(false)} />
            )}
          </div>
        </header>
        <div className="main-area">
          {active ? (
            <LedgerGrid
              key={gridKey}
              dataset={active}
              onFilteredCount={setFilteredCount}
              onApiReady={onApiReady}
              onFilterModelChange={(m) => setFilterModel(m as FilterModel)}
            />
          ) : (
            <div className="empty">
              <p>{t.empty.hint}</p>
            </div>
          )}
        </div>
        <footer className="statusbar">
          {active && (
            <>
              <button
                className="btn icon-btn"
                onClick={onClearAll}
                title={t.status.clearAllTooltip}
              >
                <IconClearFilter />
                <span className="label">{t.status.clearAll}</span>
              </button>
              <span>
                {t.status.rows}：{active.rowCount.toLocaleString()}
              </span>
              {filteredCount != null && filteredCount !== active.rowCount && (
                <span>
                  {t.status.filteredRows}：{filteredCount.toLocaleString()}
                </span>
              )}
              {numericColumns.length > 0 && (
                <>
                  <span className="spacer" />
                  <label>
                    {t.status.aggColumn}
                    <select
                      value={aggColumn}
                      onChange={(e) => setAggColumn(e.target.value)}
                      style={{ marginLeft: 4 }}
                    >
                      <option value="">{t.common.none}</option>
                      {numericColumns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {agg && (
                    <span>
                      {t.status.sum} {formatNumber(agg.sum, 2)} ｜ {t.status.avg}{' '}
                      {formatNumber(exactAverage(agg.sum, agg.count, agg.avg), 2)} ｜{' '}
                      {t.status.count} {agg.count.toLocaleString()}
                    </span>
                  )}
                </>
              )}
              {numericColumns.length === 0 && <span className="spacer" />}
              <span>{t.status.columnCount(active.columns.length)}</span>
            </>
          )}
        </footer>
      </main>}
    </div>
  );
}
