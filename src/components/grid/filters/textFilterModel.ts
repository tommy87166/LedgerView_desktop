// 文字欄篩選器的純邏輯（無 React，便於單元測試）。
// TextColumnFilter 的所有「把畫面狀態轉成 AG Grid filter model」都集中走這裡，
// 確保「清單／文字」兩種模式與重開還原的對應關係一致、可被測試釘死。
import type {
  ColumnFilter,
  CombinedFilter,
  SetFilterCondition,
  TextFilterCondition,
  TextFilterType,
} from '../../../types/filters';

/** 代表「空白（NULL 或空字串）」的內部 key；與清單面板共用。 */
export const BLANK_KEY = ' __blank__';
const ESCAPE = '\u0000';
export function listKey(value: string | null): string {
  if (value === null || value === '') return BLANK_KEY;
  return value === BLANK_KEY || value.startsWith(ESCAPE) ? ESCAPE + value : value;
}
export function listValue(key: string): string {
  return key.startsWith(ESCAPE) ? key.slice(1) : key;
}

/** 文字模式的草稿（最多兩個條件，以 AND/OR 串接）。 */
export interface TextDraft {
  type1: TextFilterType;
  filter1: string;
  join: 'AND' | 'OR';
  /** 'none' 表示單一條件。 */
  type2: TextFilterType | 'none';
  filter2: string;
}

export const EMPTY_TEXT_DRAFT: TextDraft = {
  type1: 'contains',
  filter1: '',
  join: 'AND',
  type2: 'none',
  filter2: '',
};

/** 文字運算子顯示順序（標籤由 AG Grid localeText 提供）。 */
export const TEXT_OPS: TextFilterType[] = [
  'contains',
  'notContains',
  'equals',
  'notEqual',
  'startsWith',
  'endsWith',
  'blank',
  'notBlank',
];

/** blank / notBlank 不需要輸入值。 */
export function opNeedsValue(t: TextFilterType): boolean {
  return t !== 'blank' && t !== 'notBlank';
}

/** 由現有 model 決定開窗時落在哪個模式。 */
export function modelToView(model: ColumnFilter | null): 'list' | 'text' {
  if (!model) return 'list';
  if (model.filterType === 'set') return 'list';
  return 'text'; // 單一 text 條件或 text 的 CombinedFilter
}

/** 由現有 model 還原清單勾選草稿；無篩選時預設「全部不選」（空集合）。 */
export function modelToListChecked(model: ColumnFilter | null): Set<string> {
  if (model && model.filterType === 'set') {
    const s = new Set(model.values.map(listKey));
    if (model.includeBlanks) s.add(BLANK_KEY);
    return s;
  }
  return new Set(); // 非 set（含 text / null）→ 預設全部不選
}

/**
 * 清單勾選 → set model（採「挑選要顯示的值」語意）。
 * - 已勾選包含全部值 → null（不篩選＝顯示全部）。
 * - 空集合 → values:[]（setConditionSql 產生 FALSE＝沒有資料）。
 * - 其餘 → set（IN 清單）。
 */
export function listToModel(checked: Set<string>, allValues: string[]): SetFilterCondition | null {
  const allSelected = allValues.length > 0 && allValues.every((v) => checked.has(v));
  if (allSelected) return null;
  const includeBlanks = checked.has(BLANK_KEY);
  const values = [...checked].filter((v) => v !== BLANK_KEY).map(listValue);
  return { filterType: 'set', values, includeBlanks };
}

/** 陣列（剪貼簿 {selected:[...]}）→ set model（OR / IN 語意）；空陣列 → null。 */
export function arrayToModel(values: string[]): SetFilterCondition | null {
  if (values.length === 0) return null;
  return { filterType: 'set', values: [...values], includeBlanks: false };
}

/** 單一條件草稿 → TextFilterCondition；無效（需值卻為空）→ null。 */
function oneToCondition(type: TextFilterType, filter: string): TextFilterCondition | null {
  if (!opNeedsValue(type)) {
    return { filterType: 'text', type }; // 空白 / 非空白：不帶 filter
  }
  if (filter.trim() === '') return null;
  return { filterType: 'text', type, filter };
}

/**
 * 文字草稿 → model。
 * - 兩條件皆有效 → CombinedFilter（以 join 串接）。
 * - 只有一條件有效 → 單一 TextFilterCondition（第二條件空則收斂）。
 * - 皆無效 → null。
 */
export function textDraftToModel(d: TextDraft): TextFilterCondition | CombinedFilter | null {
  const c1 = oneToCondition(d.type1, d.filter1);
  const c2 = d.type2 === 'none' ? null : oneToCondition(d.type2, d.filter2);
  if (c1 && c2) {
    return { filterType: 'text', operator: d.join, conditions: [c1, c2] };
  }
  return c1 ?? c2 ?? null;
}

/** 由現有 model 還原文字草稿（供重開）；非文字 model → 空草稿。 */
export function modelToTextDraft(model: ColumnFilter | null): TextDraft {
  if (model && model.filterType === 'text') {
    if ('conditions' in model) {
      const [c1, c2] = model.conditions as TextFilterCondition[];
      return {
        type1: c1?.type ?? 'contains',
        filter1: c1?.filter ?? '',
        join: model.operator,
        type2: c2 ? c2.type : 'none',
        filter2: c2?.filter ?? '',
      };
    }
    return { ...EMPTY_TEXT_DRAFT, type1: model.type, filter1: model.filter ?? '' };
  }
  return { ...EMPTY_TEXT_DRAFT };
}

/** 套用時的單一出口（清單／文字）：依目前模式把草稿轉成 model。陣列模式另由 arrayToModel 處理。 */
export function viewToModel(
  view: 'list' | 'text',
  listChecked: Set<string>,
  textDraft: TextDraft,
  allValues: string[],
): ColumnFilter | null {
  return view === 'list' ? listToModel(listChecked, allValues) : textDraftToModel(textDraft);
}
