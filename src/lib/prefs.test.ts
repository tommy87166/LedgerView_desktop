import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROW_HEIGHT, getRowHeightPref, setRowHeightPref } from './prefs';

function mockStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}

describe('prefs：行距偏好', () => {
  let store: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    store = mockStorage();
    vi.stubGlobal('localStorage', store);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('空儲存 → 預設', () => {
    expect(getRowHeightPref()).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('存預設 px → 取回該值', () => {
    setRowHeightPref(44);
    expect(store.getItem('lv.rowHeight')).toBe('44');
    expect(getRowHeightPref()).toBe(44);
  });

  it('範圍內非預設 px（35）→ 該值（容忍日後微調）', () => {
    store.setItem('lv.rowHeight', '35');
    expect(getRowHeightPref()).toBe(35);
  });

  it('垃圾 / 超界 → 預設', () => {
    for (const bad of ['abc', '0', '999', '', '-10']) {
      store.setItem('lv.rowHeight', bad);
      expect(getRowHeightPref()).toBe(DEFAULT_ROW_HEIGHT);
    }
  });

  it('getItem 丟錯 → 預設（catch）', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(getRowHeightPref()).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('setRowHeightPref 非有限數不寫、不丟錯', () => {
    setRowHeightPref(Number.NaN);
    expect(store.getItem('lv.rowHeight')).toBeNull();
    expect(() => setRowHeightPref(Number.POSITIVE_INFINITY)).not.toThrow();
  });
});
