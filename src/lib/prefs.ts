// 使用者顯示偏好（持久化於 localStorage）。目前僅表格行距（列高）。
// 採手動 get/set（不依賴 zustand persist），保持 store 無依賴、便於單元測試。

export interface RowHeightPreset {
  key: 'compact' | 'standard' | 'relaxed' | 'wide';
  label: string;
  px: number;
}

// 「標準」= 36px：與 theme spacing:6 推導出的現況一致（已於瀏覽器量測校正）。
export const ROW_HEIGHT_PRESETS: RowHeightPreset[] = [
  { key: 'compact', label: '緊湊', px: 28 },
  { key: 'standard', label: '標準', px: 36 },
  { key: 'relaxed', label: '寬鬆', px: 44 },
  { key: 'wide', label: '特寬', px: 54 },
];

export const DEFAULT_ROW_HEIGHT = 36; // = 標準.px，兩者需同步

const STORAGE_KEY = 'lv.rowHeight';
const ALLOWED = new Set(ROW_HEIGHT_PRESETS.map((p) => p.px));

/** 讀取行距偏好；無值或不合理一律回預設。容忍日後微調 px（接受 20..80 區間）。 */
export function getRowHeightPref(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_ROW_HEIGHT;
    const n = Number(raw);
    if (Number.isFinite(n) && (ALLOWED.has(n) || (n >= 20 && n <= 80))) return n;
    return DEFAULT_ROW_HEIGHT;
  } catch {
    return DEFAULT_ROW_HEIGHT;
  }
}

/** 寫入行距偏好；非有限數忽略；localStorage 不可用時靜默略過。 */
export function setRowHeightPref(px: number): void {
  try {
    if (Number.isFinite(px)) localStorage.setItem(STORAGE_KEY, String(px));
  } catch {
    /* quota / 停用儲存 */
  }
}

// ---- 介面語言偏好（持久化於 localStorage）-----------------------------------

export type LangPref = 'zh-TW' | 'en';

const LANG_KEY = 'lv.lang';
const LANG_VALUES = new Set<LangPref>(['zh-TW', 'en']);

/** 依瀏覽器語言推測預設：zh* → zh-TW，其餘 → en。 */
function detectDefaultLang(): LangPref {
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator.language ?? '') : '';
    return nav.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en';
  } catch {
    return 'zh-TW';
  }
}

/** 讀取語言偏好；無值或不合法則依瀏覽器語言推測。 */
export function getLangPref(): LangPref {
  try {
    const raw = localStorage.getItem(LANG_KEY) as LangPref | null;
    if (raw && LANG_VALUES.has(raw)) return raw;
  } catch {
    /* 停用儲存 → 走偵測 */
  }
  return detectDefaultLang();
}

/** 寫入語言偏好；localStorage 不可用時靜默略過。 */
export function setLangPref(lang: LangPref): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* quota / 停用儲存 */
  }
}
