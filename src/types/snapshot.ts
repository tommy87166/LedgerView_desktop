import type { FilterModel, SortModel } from './filters';

export interface SnapshotMeta {
  id: string;
  /** DuckDB 中的快照表名稱，如 'snap_xxxx'。 */
  tableName: string;
  displayName: string;
  /** 來源資料表名稱。 */
  sourceTable: string;
  /** 來源資料集顯示名稱（方便 UI 顯示）。 */
  sourceDisplayName: string;
  /** 原始 filterModel（可重現／顯示）。 */
  filterModel: FilterModel;
  /** 原始 sortModel。 */
  sortModel: SortModel;
  /** 人類可讀的篩選描述，如「科目 包含 '銀行' 且 金額 > 10000」。 */
  filterDesc: string;
  rowCount: number;
  columnCount: number;
  createdAt: string;
}
