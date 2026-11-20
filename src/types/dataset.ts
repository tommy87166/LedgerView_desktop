export type DisplayType = 'text' | 'number' | 'date' | 'datetime' | 'boolean';
export interface ColumnMeta {
  name: string;
  duckdbType: string;
  displayType: DisplayType;
}
export interface DatasetMeta {
  id: string;
  tableName: string;
  displayName: string;
  sourceFile: string;
  kind: 'view' | 'table';
  rowCount: number;
  rowKey: string;
  columns: ColumnMeta[];
  importedAt: string;
  ephemeral: boolean;
  hiddenColumns?: string[];
}
