import { create } from 'zustand';
import type { DatasetMeta } from '../types/dataset';

interface DatasetsState {
  datasets: DatasetMeta[];
  activeId: string | null;
  setDatasets: (list: DatasetMeta[]) => void;
  addDataset: (ds: DatasetMeta) => void;
  removeDataset: (id: string) => void;
  renameDataset: (id: string, name: string) => void;
  setActive: (id: string | null) => void;
  /** 設定某分頁的隱藏欄位（session-only，不寫入 _lv_datasets）。 */
  setHiddenColumns: (id: string, hidden: string[]) => void;
  getActive: () => DatasetMeta | null;
}

export const useDatasets = create<DatasetsState>((set, get) => ({
  datasets: [],
  activeId: null,
  setDatasets: (list) =>
    set((s) => ({
      datasets: list,
      activeId: s.activeId ?? (list.length > 0 ? list[0].id : null),
    })),
  addDataset: (ds) =>
    set((s) => ({
      datasets: s.datasets.some((d) => d.id === ds.id) ? s.datasets : [...s.datasets, ds],
      activeId: ds.id,
    })),
  removeDataset: (id) =>
    set((s) => {
      const datasets = s.datasets.filter((d) => d.id !== id);
      const activeId = s.activeId === id ? (datasets[0]?.id ?? null) : s.activeId;
      return { datasets, activeId };
    }),
  renameDataset: (id, name) =>
    set((s) => ({
      datasets: s.datasets.map((d) => (d.id === id ? { ...d, displayName: name } : d)),
    })),
  setActive: (id) => set({ activeId: id }),
  setHiddenColumns: (id, hidden) =>
    set((s) => ({
      datasets: s.datasets.map((d) => (d.id === id ? { ...d, hiddenColumns: hidden } : d)),
    })),
  getActive: () => {
    const { datasets, activeId } = get();
    return datasets.find((d) => d.id === activeId) ?? null;
  },
}));
