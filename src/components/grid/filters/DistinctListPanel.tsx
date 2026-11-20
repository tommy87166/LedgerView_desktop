import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColumnMeta } from '../../../types/dataset';
import type { FilterModel } from '../../../types/filters';
import { useGridLocale, useMessages } from '../../../i18n';
import { request } from '../../../lib/native';
import { BLANK_KEY, listKey, listValue } from './textFilterModel';

const DISTINCT_LIMIT = 1000;

interface Props {
  datasetId: string;
  columnMeta: ColumnMeta;
  /** 受控勾選集合（採「挑要顯示的值」語意；空集合＝全部不選）。 */
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  /** 其他欄目前已套用的篩選（Excel 連動）。 */
  getOtherFilters: () => FilterModel;
  /** 父層每次開窗 bump → 重載 distinct（反映他欄篩選）。 */
  reloadKey: number;
  /** 回報目前載入的相異值，供父層套用時判斷「全選」。 */
  onValuesLoaded: (values: string[], truncated?: boolean) => void;
}

/**
 * 純呈現的勾選式清單。預設全部不選；上方「全選／取消以下項目」作用於目前可見值。
 * distinct 一次載入（≤1000），搜尋於前端過濾。實際 model 由父層 commit。
 */
export function DistinctListPanel({
  datasetId,
  columnMeta,
  checked,
  onChange,
  getOtherFilters,
  reloadKey,
  onValuesLoaded,
}: Props) {
  const t = useMessages();
  const grid = useGridLocale();
  const [allValues, setAllValues] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const loadDistinct = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await request('distinct', {
        id: datasetId,
        column: columnMeta.name,
        filters: getOtherFilters(),
        limited: true,
      });
      const vals = [...new Set(raw.slice(0, DISTINCT_LIMIT).map(listKey))];
      setTruncated(raw.length > DISTINCT_LIMIT);
      setAllValues(vals);
      onValuesLoaded(vals, raw.length > DISTINCT_LIMIT);
    } catch {
      setAllValues([]);
      onValuesLoaded([]);
    } finally {
      setLoading(false);
    }
  }, [datasetId, columnMeta, getOtherFilters, onValuesLoaded]);

  // 掛載與每次開窗（reloadKey）重載。
  useEffect(() => {
    void loadDistinct();
  }, [reloadKey, loadDistinct]);

  // 搜尋在前端過濾（搜尋時不含 (空白)）。
  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!t) return allValues;
    return allValues.filter((v) => v !== BLANK_KEY && v.toLowerCase().includes(t));
  }, [allValues, search]);

  const toggle = (v: string) => {
    const base = new Set(checked);
    if (base.has(v)) base.delete(v);
    else base.add(v);
    onChange(base);
  };

  const allVisibleChecked = visible.length > 0 && visible.every((v) => checked.has(v));

  // 「全選／取消以下項目」：作用於目前可見值，其餘維持原樣。
  const toggleVisible = () => {
    const base = new Set(checked);
    if (allVisibleChecked) visible.forEach((v) => base.delete(v));
    else visible.forEach((v) => base.add(v));
    onChange(base);
  };

  const label = (key: string) => (key === BLANK_KEY ? t.common.blank : listValue(key));

  return (
    <div className="distinct-filter">
      <input
        type="text"
        placeholder={grid.searchOoo}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="distinct-master">
        <a onClick={toggleVisible}>{t.filter.selectToggle}</a>
        <span className="distinct-count">{t.filter.selectedCount(checked.size)}</span>
      </div>
      <div className="distinct-list">
        {visible.length === 0 && !loading ? (
          <div className="hint" style={{ padding: 8 }}>
            {grid.noMatches}
          </div>
        ) : (
          visible.map((key) => (
            <label key={key} className="distinct-row">
              <input type="checkbox" checked={checked.has(key)} onChange={() => toggle(key)} />
              <span>{label(key)}</span>
            </label>
          ))
        )}
      </div>
      {loading && <div className="hint">{grid.loadingOoo}</div>}
      {truncated && <div className="hint">{t.filter.truncated(DISTINCT_LIMIT)}</div>}
    </div>
  );
}
