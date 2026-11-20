import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { useCallback, useRef, useState } from 'react';
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react';
import type { IAfterGuiAttachedParams } from 'ag-grid-community';
import type { ColumnMeta } from '../../../types/dataset';
import type { ColumnFilter, FilterModel } from '../../../types/filters';
import { useGridLocale, useMessages } from '../../../i18n';
import { DistinctListPanel } from './DistinctListPanel';
import { TextConditionPanel } from './TextConditionPanel';
import {
  EMPTY_TEXT_DRAFT,
  arrayToModel,
  modelToListChecked,
  modelToTextDraft,
  modelToView,
  viewToModel,
  type TextDraft,
} from './textFilterModel';

export interface TextColumnFilterParams {
  datasetId: string;
  // 注意：不可命名為 column，會與 AG Grid 內建的 column 參數衝突。
  columnMeta: ColumnMeta;
}

type View = 'list' | 'text' | 'array';
type Model = ColumnFilter | null;
type Props = CustomFilterProps<unknown, unknown, Model> & TextColumnFilterParams;

/**
 * 文字欄的整合篩選器：清單（仿 Excel 勾選，預設全部不選）／文字（運算子）／
 * 陣列（讀剪貼簿 {selected:[...]} 做 OR 篩選）。只有「套用／清除」會改變實際篩選。
 */
export function TextColumnFilter(props: Props) {
  const { model, onModelChange, api, datasetId, columnMeta } = props;
  const t = useMessages();
  const grid = useGridLocale();

  const MODES: { key: View; label: string }[] = [
    { key: 'list', label: t.filter.modeList },
    { key: 'text', label: t.filter.modeText },
    { key: 'array', label: t.filter.modeArray },
  ];

  // boolean 欄只有 true/false 兩值，文字／陣列模式無意義 → 僅保留清單（仿 Excel 勾選）。
  const listOnly = columnMeta.displayType === 'boolean';

  const [view, setView] = useState<View>(() => (listOnly ? 'list' : modelToView(model)));
  const [listChecked, setListChecked] = useState<Set<string>>(() => modelToListChecked(model));
  const [textDraft, setTextDraft] = useState<TextDraft>(() => modelToTextDraft(model));
  const [arrayValues, setArrayValues] = useState<string[] | null>(null);
  const [arrayError, setArrayError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const allValuesRef = useRef<string[]>([]);
  const hidePopupRef = useRef<(() => void) | null>(null);

  // 其他欄目前已套用的篩選（排除本欄），用於 Excel 連動的 distinct。
  const getOtherFilters = useCallback((): FilterModel => {
    const fm = { ...(api.getFilterModel() ?? {}) } as FilterModel;
    delete fm[columnMeta.name];
    return fm;
  }, [api, columnMeta.name]);

  // 讀剪貼簿的 {selected:[...]}（切到陣列模式或按「重新讀取」時）。
  const readClipboardArray = useCallback(async () => {
    setArrayError(null);
    setArrayValues(null);
    try {
      const text = await readText();
      const parsed: unknown = JSON.parse(text);
      const sel = (parsed as { selected?: unknown })?.selected;
      if (Array.isArray(sel)) {
        setArrayValues(sel.map((x) => String(x)));
      } else {
        setArrayError(t.filter.arrayFormatError);
      }
    } catch {
      setArrayError(t.filter.arrayReadError);
    }
  }, [t]);

  const switchTo = useCallback(
    (v: View) => {
      setView(v);
      if (v === 'array') void readClipboardArray();
    },
    [readClipboardArray],
  );

  // 每次開窗：保存 hidePopup、把草稿重設為「上次套用」狀態、重載 distinct。
  // 直接向 API 取目前已套用的 model：popup 關閉時 AG Grid 不會重渲染本元件，
  // 故不能依賴 props.model / ref（會是上次開窗時的舊值）。
  useGridFilter({
    doesFilterPass: useCallback(() => true, []),
    afterGuiAttached: useCallback(
      (params?: IAfterGuiAttachedParams) => {
        hidePopupRef.current = params?.hidePopup ?? null;
        const m = (api.getColumnFilterModel(columnMeta.name) ?? null) as Model;
        setView(listOnly ? 'list' : modelToView(m));
        setListChecked(modelToListChecked(m));
        setTextDraft(modelToTextDraft(m));
        setArrayValues(null);
        setArrayError(null);
        setReloadKey((k) => k + 1);
      },
      [api, columnMeta.name, listOnly],
    ),
  });

  const onValuesLoaded = useCallback((values: string[], truncated = false) => {
    allValuesRef.current = truncated ? [] : values;
  }, []);

  const apply = useCallback(() => {
    const m =
      view === 'array'
        ? arrayToModel(arrayValues ?? [])
        : viewToModel(view, listChecked, textDraft, allValuesRef.current);
    onModelChange(m);
    hidePopupRef.current?.();
  }, [view, listChecked, textDraft, arrayValues, onModelChange]);

  const clear = useCallback(() => {
    setListChecked(new Set());
    setTextDraft({ ...EMPTY_TEXT_DRAFT });
    setArrayValues(null);
    setArrayError(null);
    onModelChange(null);
    hidePopupRef.current?.();
  }, [onModelChange]);

  return (
    <div className="text-column-filter">
      {view === 'list' && (
        <DistinctListPanel
          datasetId={datasetId}
          columnMeta={columnMeta}
          checked={listChecked}
          onChange={setListChecked}
          getOtherFilters={getOtherFilters}
          reloadKey={reloadKey}
          onValuesLoaded={onValuesLoaded}
        />
      )}
      {view === 'text' && <TextConditionPanel value={textDraft} onChange={setTextDraft} />}
      {view === 'array' && (
        <div className="array-filter">
          {arrayValues ? (
            <div className="hint">
              {t.filter.arrayLoadedPre}
              <b>{arrayValues.length}</b>
              {t.filter.arrayLoadedPost}
            </div>
          ) : arrayError ? (
            <div className="hint array-error">{arrayError}</div>
          ) : (
            <div className="hint">{t.filter.arrayReading}</div>
          )}
          <button className="btn" onClick={() => void readClipboardArray()}>
            {t.filter.reread}
          </button>
        </div>
      )}

      {!listOnly && (
        <div className="filter-switch">
          {MODES.filter((m) => m.key !== view).map((m) => (
            <a key={m.key} onClick={() => switchTo(m.key)}>
              {m.key === 'list' ? t.filter.backToList : t.filter.switchTo(m.label)}
            </a>
          ))}
        </div>
      )}

      <div className="filter-footer">
        <button className="btn" onClick={clear}>
          {grid.clearFilter}
        </button>
        <button className="btn primary" onClick={apply}>
          {grid.applyFilter}
        </button>
      </div>
    </div>
  );
}
