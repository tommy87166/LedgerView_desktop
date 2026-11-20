// AG Grid filterModel 的 TypeScript 對應型別。
// 我們只取用 Infinite Row Model 會送到 datasource 的子集。

export type TextFilterType =
  | 'equals'
  | 'notEqual'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'blank'
  | 'notBlank';

export type NumberFilterType =
  | 'equals'
  | 'notEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'inRange'
  | 'blank'
  | 'notBlank';

export type DateFilterType =
  | 'equals'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'inRange'
  | 'blank'
  | 'notBlank';

export interface TextFilterCondition {
  filterType: 'text';
  type: TextFilterType;
  filter?: string;
}

export interface NumberFilterCondition {
  filterType: 'number';
  type: NumberFilterType;
  filter?: number | string;
  filterTo?: number | string;
}

export interface DateFilterCondition {
  filterType: 'date';
  type: DateFilterType;
  dateFrom?: string;
  dateTo?: string;
}

/** 自訂 DISTINCT 勾選篩選器（仿 Excel AutoFilter）。 */
export interface SetFilterCondition {
  filterType: 'set';
  values: string[];
  includeBlanks: boolean;
}

export type SimpleFilterCondition =
  | TextFilterCondition
  | NumberFilterCondition
  | DateFilterCondition;

/** 複合條件（AG Grid v29+ 的 conditions 陣列形狀）。 */
export interface CombinedFilter {
  filterType: 'text' | 'number' | 'date';
  operator: 'AND' | 'OR';
  conditions: SimpleFilterCondition[];
}

export type ColumnFilter = SimpleFilterCondition | CombinedFilter | SetFilterCondition;

export type FilterModel = Record<string, ColumnFilter>;

export interface SortModelItem {
  colId: string;
  sort: 'asc' | 'desc';
}

export type SortModel = SortModelItem[];
