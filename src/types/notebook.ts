import type { ColumnMeta } from './dataset';
import type { SnapshotMeta } from './snapshot';

export interface NotebookSource {
  name: string;
  isSnapshot: boolean;
  columns: ColumnMeta[];
}
export interface SqlVocabulary {
  keywords: string[];
  functions: string[];
  tableFunctions: string[];
  types: string[];
}
export interface SqlCell {
  slot: number;
  name: string;
  sql: string;
}
export interface Notebook {
  id: string;
  name: string;
  cells: SqlCell[];
}
// Notebooks saved before cell deletion used each cell's original array index.
export type StoredNotebook = Omit<Notebook, 'cells'> & {
  cells: (Omit<SqlCell, 'slot'> & { slot?: number })[];
};
export interface QueryResult {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  total: number;
  elapsedMs: number;
  snapshot: SnapshotMeta | null;
}
