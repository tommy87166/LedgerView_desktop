// i18n 註冊表與執行期語言切換。
// - React 元件：useMessages() / useGridLocale() / useLang()（以 useSyncExternalStore 訂閱，切換時自動重繪）。
// - 非 React 模組（lib/*）：getMessages() / getGridLocale()（讀目前語言）。
// 單一事實來源即本模組的 currentLang；store 不持有語言狀態，避免循環相依。
import { useSyncExternalStore } from 'react';
import { GRID_ZH_TW, MESSAGES_ZH_TW, type GridLocale, type Messages } from './zh-TW';
import { GRID_EN, MESSAGES_EN } from './en';
import { getLangPref, setLangPref } from '../lib/prefs';

export type Lang = 'zh-TW' | 'en';

export const LANGS: Lang[] = ['zh-TW', 'en'];

const MESSAGES: Record<Lang, Messages> = {
  'zh-TW': MESSAGES_ZH_TW,
  en: MESSAGES_EN,
};

const GRID: Record<Lang, GridLocale> = {
  'zh-TW': GRID_ZH_TW,
  en: GRID_EN,
};

/** 各語言的自我顯示名稱（供語言切換 UI）。 */
export const LANG_NAMES: Record<Lang, string> = {
  'zh-TW': MESSAGES_ZH_TW.langName,
  en: MESSAGES_EN.langName,
};

let currentLang: Lang = getLangPref();

// 初始化 <html lang>（切換時 setLang 會再更新）。
if (typeof document !== 'undefined') {
  document.documentElement.lang = currentLang === 'zh-TW' ? 'zh-Hant' : 'en';
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 目前語言（供非 React 模組讀取）。 */
export function getLang(): Lang {
  return currentLang;
}

/** 切換語言：更新狀態、持久化、通知訂閱者重繪。 */
export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  setLangPref(lang);
  document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : 'en';
  emit();
}

/** 目前（或指定）語言的應用層字串。 */
export function getMessages(lang: Lang = currentLang): Messages {
  return MESSAGES[lang];
}

/** 目前（或指定）語言的 AG Grid localeText。 */
export function getGridLocale(lang: Lang = currentLang): GridLocale {
  return GRID[lang];
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React：訂閱目前語言，切換時觸發重繪。 */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** React：目前語言的應用層字串。 */
export function useMessages(): Messages {
  return getMessages(useLang());
}

/** React：目前語言的 AG Grid localeText。 */
export function useGridLocale(): GridLocale {
  return getGridLocale(useLang());
}

export type { Messages, GridLocale };
