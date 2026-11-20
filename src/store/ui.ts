import { create } from 'zustand';
import { randomId } from '../lib/util/ids';
import { getRowHeightPref, setRowHeightPref } from '../lib/prefs';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface UiState {
  /** DuckDB 是否初始化完成。 */
  dbReady: boolean;
  /** 是否將工作階段保存到本機磁碟（null = 尚未得知）。 */
  persistent: boolean | null;
  /** 初始化錯誤訊息。 */
  dbError: string | null;
  toasts: Toast[];
  /** 表格列高（行距），全域顯示偏好，持久化於 localStorage。 */
  rowHeight: number;

  setDbReady: (persistent: boolean) => void;
  setDbError: (msg: string) => void;
  toast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
  setRowHeight: (px: number) => void;
}

export const useUi = create<UiState>((set) => ({
  dbReady: false,
  persistent: null,
  dbError: null,
  toasts: [],
  rowHeight: getRowHeightPref(),

  setDbReady: (persistent) => set({ dbReady: true, persistent }),
  setDbError: (msg) => set({ dbError: msg }),
  toast: (kind, message) =>
    set((s) => ({ toasts: [...s.toasts, { id: randomId('t_'), kind, message }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setRowHeight: (px) => {
    setRowHeightPref(px);
    set({ rowHeight: px });
  },
}));
