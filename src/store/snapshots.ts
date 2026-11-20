import { create } from 'zustand';
import type { SnapshotMeta } from '../types/snapshot';

interface SnapshotsState {
  snapshots: SnapshotMeta[];
  setSnapshots: (list: SnapshotMeta[]) => void;
  addSnapshot: (s: SnapshotMeta) => void;
  removeSnapshot: (id: string) => void;
  renameSnapshot: (id: string, displayName: string) => void;
}

export const useSnapshots = create<SnapshotsState>((set) => ({
  snapshots: [],
  setSnapshots: (list) => set({ snapshots: list }),
  addSnapshot: (snap) => set((s) => ({ snapshots: [snap, ...s.snapshots] })),
  removeSnapshot: (id) => set((s) => ({ snapshots: s.snapshots.filter((x) => x.id !== id) })),
  renameSnapshot: (id, displayName) =>
    set((s) => ({
      snapshots: s.snapshots.map((x) => (x.id === id ? { ...x, displayName } : x)),
    })),
}));
