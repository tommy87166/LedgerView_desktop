/** 產生短亂數識別碼（用於 store key 與內部識別）。 */
export function randomId(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return prefix ? `${prefix}${rnd}` : rnd;
}

/** 清理檔名中對檔案系統不安全的字元（用於下載檔名）。 */
export function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'export'
  );
}
