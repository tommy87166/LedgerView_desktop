import { useCallback, useEffect, useRef, useState } from 'react';
import type { GridApi } from 'ag-grid-community';
import { useDatasets } from '../../store/datasets';
import { useSnapshots } from '../../store/snapshots';
import { useUi } from '../../store/ui';
import { useImportManager } from '../../hooks/useImportManager';
import { LedgerGrid } from '../grid/LedgerGrid';
import { ColumnPicker } from '../grid/ColumnPicker';
import { RowHeightPicker } from '../grid/RowHeightPicker';
import { SnapshotPanel } from '../snapshots/SnapshotPanel';
import { confirm } from '@tauri-apps/plugin-dialog';
import { ChangelogModal } from '../common/ChangelogModal';
import {
  Logo,
  IconOpen,
  IconSnapshot,
  IconManage,
  IconColumns,
  IconRowHeight,
  IconClearFilter,
  IconChangelog,
} from '../common/icons';
import { request, type Aggregate } from '../../lib/native';
import { formatNumber, exactAverage } from '../../lib/numbers';
import { describeFilters } from '../../lib/describeFilter';
import { setLang, useLang, useMessages } from '../../i18n';
import type { SnapshotMeta } from '../../types/snapshot';
import type { FilterModel, SortModel } from '../../types/filters';

export function AppShell() {
  const t = useMessages();
  const lang = useLang();
  const otherLang = lang === 'zh-TW' ? 'en' : 'zh-TW';
  const datasets = useDatasets((s) => s.datasets);
  const activeId = useDatasets((s) => s.activeId);
  const setActive = useDatasets((s) => s.setActive);
  const addDataset = useDatasets((s) => s.addDataset);
  const removeDataset = useDatasets((s) => s.removeDataset);
  const persistent = useUi((s) => s.persistent);
  const toast = useUi((s) => s.toast);
  const snapshotPaneOpen = useUi((s) => s.snapshotPaneOpen);
  const toggleSnapshotPane = useUi((s) => s.toggleSnapshotPane);
  const rowHeight = useUi((s) => s.rowHeight);
  const setRowHeight = useUi((s) => s.setRowHeight);
  const snapshotCount = useSnapshots((s) => s.snapshots.length);
  const addSnapshot = useSnapshots((s) => s.addSnapshot);

  const { importing, openPicker, dragOver } = useImportManager();
  const gridApiRef = useRef<GridApi | null>(null);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [filterModel, setFilterModel] = useState<FilterModel>({});
  const [aggColumn, setAggColumn] = useState<string>('');
  const [agg, setAgg] = useState<Aggregate | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapPaneWidth, setSnapPaneWidth] = useState(340);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [colPickerOpen, setColPickerOpen] = useState(false);
  const [rowHeightPickerOpen, setRowHeightPickerOpen] = useState(false);
  const [diskAvail, setDiskAvail] = useState<string | null>(null);

  const active = datasets.find((d) => d.id === activeId) ?? null;
  const numericColumns = active?.columns.filter((c) => c.displayType === 'number') ?? [];
  const selectedNumericColumn = numericColumns.find((column) => column.name === aggColumn);

  // 切換資料集時重置篩選彙總狀態（避免沿用前一個分頁的篩選）。
  useEffect(() => {
    setFilterModel({});
    setAggColumn('');
    setFilteredCount(null);
    setColPickerOpen(false);
    setRowHeightPickerOpen(false);
  }, [activeId, lang]);

  // 更新工作區磁碟可用空間。
  useEffect(() => {
    if (persistent !== true) return;
    let alive = true;
    void request('diskSpace', {})
      .then((bytes) => {
        if (alive) setDiskAvail(bytes != null ? (bytes / 1024 ** 3).toFixed(1) + ' GiB' : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [persistent, datasets.length, snapshotCount]);

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

  // 工具列「快照」：以目前篩選＋排序建立快照，並確保快照面板開啟。
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
      if (!snapshotPaneOpen) toggleSnapshotPane();
      toast('success', t.snapshot.created(snap.displayName, snap.rowCount.toLocaleString()));
    } catch (err) {
      toast('error', t.snapshot.createFailed(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }, [active, getCurrentModels, addSnapshot, snapshotPaneOpen, toggleSnapshotPane, toast, t]);

  // 點選快照 → 開成預覽分頁（同一快照只開一個）。
  const onOpenSnapshotPreview = useCallback(
    async (snap: SnapshotMeta) => {
      const id = snap.id;
      if (datasets.some((d) => d.id === id)) {
        setActive(id);
        return;
      }
      try {
        const ds = await request('describe', { id });
        addDataset(ds);
      } catch (err) {
        toast('error', t.snapshot.openFailed(err instanceof Error ? err.message : String(err)));
      }
    },
    [datasets, setActive, addDataset, toast, t],
  );

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
      <div className="topbar">
        <div className="brand">
          <Logo />
          <h1>{t.appName}</h1>
          <button
            className="changelog-btn"
            onClick={() => setChangelogOpen(true)}
            title={t.topbar.changelogTooltip}
          >
            <IconChangelog />
            <span className="label">{t.topbar.changelog}</span>
          </button>
          <button
            className="changelog-btn lang-chip"
            onClick={() => setLang(otherLang)}
            title={t.lang.switchTooltip}
            aria-label={t.lang.switchTooltip}
          >
            {otherLang === 'en' ? 'EN' : '中'}
          </button>
        </div>
        {persistent === true && (
          <span className="badge persistent" title={t.topbar.persistentAvailTooltip}>
            {diskAvail ? t.topbar.persistentBadgeAvail(diskAvail) : t.topbar.persistentBadge}
          </span>
        )}
        {persistent === false && <span className="badge memory">{t.topbar.memoryBadge}</span>}
        <div className="spacer" />
        {importing && <span className="hint">{t.topbar.importing}</span>}
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
            title={t.topbar.columnsTooltip}
          >
            <IconColumns />
            <span className="label">{t.topbar.columns}</span>
          </button>
          {colPickerOpen && active && (
            <ColumnPicker dataset={active} onClose={() => setColPickerOpen(false)} />
          )}
        </div>
        <div className="col-picker-wrap">
          <button
            className={`btn icon-btn ${rowHeightPickerOpen ? 'active' : ''}`}
            onClick={() => setRowHeightPickerOpen((o) => !o)}
            disabled={!active}
            title={t.topbar.rowHeightTooltip}
          >
            <IconRowHeight />
            <span className="label">{t.topbar.rowHeight}</span>
          </button>
          {rowHeightPickerOpen && active && (
            <RowHeightPicker
              value={rowHeight}
              onChange={setRowHeight}
              onClose={() => setRowHeightPickerOpen(false)}
            />
          )}
        </div>
        <button
          className={`btn icon-btn ${snapshotPaneOpen ? 'active' : ''}`}
          onClick={toggleSnapshotPane}
          title={t.topbar.manageSnapshotTooltip}
        >
          <IconManage />
          <span className="label">
            {t.topbar.manageSnapshot}（{snapshotCount}）
          </span>
        </button>
        <button
          className="btn primary icon-btn"
          onClick={openPicker}
          disabled={importing}
          title={t.topbar.openFileTooltip}
        >
          <IconOpen />
          <span className="label">{t.topbar.openFile}</span>
        </button>
      </div>

      {datasets.length > 0 && (
        <div className="tabs">
          {datasets.map((d) => (
            <div
              key={d.id}
              className={`tab ${d.id === activeId ? 'active' : ''}`}
              onClick={() => setActive(d.id)}
            >
              <span>{d.displayName}</span>
              {d.ephemeral && (
                <span className="tab-badge snapshot" title={t.tabs.snapshotPreview}>
                  {t.tabs.snapshot}
                </span>
              )}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  void onCloseDataset(d.id);
                }}
              >
                ×
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="content">
        <div className="main-area">
          {active ? (
            <LedgerGrid
              key={`${active.id}-${lang}`}
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
        {snapshotPaneOpen && (
          <SnapshotPanel
            width={snapPaneWidth}
            onResize={setSnapPaneWidth}
            onOpenPreview={(snap) => void onOpenSnapshotPreview(snap)}
          />
        )}
      </div>

      {active && (
        <div className="statusbar">
          <button className="btn icon-btn" onClick={onClearAll} title={t.status.clearAllTooltip}>
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
                  {formatNumber(exactAverage(agg.sum, agg.count, agg.avg), 2)} ｜ {t.status.count}{' '}
                  {agg.count.toLocaleString()}
                </span>
              )}
            </>
          )}
          {numericColumns.length === 0 && <span className="spacer" />}
          <span>{t.status.columnCount(active.columns.length)}</span>
        </div>
      )}

      {changelogOpen && <ChangelogModal onClose={() => setChangelogOpen(false)} />}
    </div>
  );
}
