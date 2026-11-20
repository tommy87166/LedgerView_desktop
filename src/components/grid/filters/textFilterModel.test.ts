import { describe, expect, it } from 'vitest';
import {
  arrayToModel,
  BLANK_KEY,
  listKey,
  EMPTY_TEXT_DRAFT,
  listToModel,
  modelToListChecked,
  modelToTextDraft,
  modelToView,
  textDraftToModel,
  viewToModel,
  type TextDraft,
} from './textFilterModel';

describe('modelToView', () => {
  it('null → list', () => {
    expect(modelToView(null)).toBe('list');
  });
  it('set → list', () => {
    expect(modelToView({ filterType: 'set', values: ['a'], includeBlanks: false })).toBe('list');
  });
  it('單一 text 條件 → text', () => {
    expect(modelToView({ filterType: 'text', type: 'equals', filter: '現金' })).toBe('text');
  });
  it('text 的 CombinedFilter → text', () => {
    expect(
      modelToView({
        filterType: 'text',
        operator: 'OR',
        conditions: [
          { filterType: 'text', type: 'startsWith', filter: 'A' },
          { filterType: 'text', type: 'endsWith', filter: 'Z' },
        ],
      }),
    ).toBe('text');
  });
});

describe('listToModel', () => {
  const all = ['現金', '銀行存款', '應收帳款'];

  it('全部勾選 → null（不篩選）', () => {
    expect(listToModel(new Set(all), all)).toBeNull();
  });
  it('空集合（全不選）→ set values:[]（FALSE＝沒資料）', () => {
    expect(listToModel(new Set<string>(), all)).toEqual({
      filterType: 'set',
      values: [],
      includeBlanks: false,
    });
  });
  it('部分勾選 → set（含 BLANK_KEY → includeBlanks）', () => {
    expect(listToModel(new Set(['現金', BLANK_KEY]), all)).toEqual({
      filterType: 'set',
      values: ['現金'],
      includeBlanks: true,
    });
  });
});

describe('modelToListChecked', () => {
  it('set → 還原勾選集合（含 blank）', () => {
    const s = modelToListChecked({ filterType: 'set', values: ['現金'], includeBlanks: true });
    expect(s).toEqual(new Set(['現金', BLANK_KEY]));
  });
  it('null / text → 空集合（預設全部不選）', () => {
    expect(modelToListChecked(null)).toEqual(new Set());
    expect(modelToListChecked({ filterType: 'text', type: 'contains', filter: 'x' })).toEqual(
      new Set(),
    );
  });
});

describe('arrayToModel', () => {
  it('非空陣列 → set（OR/IN）', () => {
    expect(arrayToModel(['甲', '乙', '丙'])).toEqual({
      filterType: 'set',
      values: ['甲', '乙', '丙'],
      includeBlanks: false,
    });
  });
  it('空陣列 → null', () => {
    expect(arrayToModel([])).toBeNull();
  });
});

describe('textDraftToModel', () => {
  it('單一 contains → 單一條件', () => {
    const d: TextDraft = { ...EMPTY_TEXT_DRAFT, type1: 'contains', filter1: '銀行' };
    expect(textDraftToModel(d)).toEqual({ filterType: 'text', type: 'contains', filter: '銀行' });
  });
  it('blank：不帶 filter', () => {
    const d: TextDraft = { ...EMPTY_TEXT_DRAFT, type1: 'blank', filter1: '' };
    expect(textDraftToModel(d)).toEqual({ filterType: 'text', type: 'blank' });
  });
  it('需值卻空 → null', () => {
    const d: TextDraft = { ...EMPTY_TEXT_DRAFT, type1: 'contains', filter1: '   ' };
    expect(textDraftToModel(d)).toBeNull();
  });
  it('兩條件 OR → CombinedFilter', () => {
    const d: TextDraft = {
      type1: 'startsWith',
      filter1: 'A',
      join: 'OR',
      type2: 'endsWith',
      filter2: 'Z',
    };
    expect(textDraftToModel(d)).toEqual({
      filterType: 'text',
      operator: 'OR',
      conditions: [
        { filterType: 'text', type: 'startsWith', filter: 'A' },
        { filterType: 'text', type: 'endsWith', filter: 'Z' },
      ],
    });
  });
  it('第二條件空且非 blank → 收斂為單條件', () => {
    const d: TextDraft = {
      type1: 'contains',
      filter1: '銀行',
      join: 'AND',
      type2: 'equals',
      filter2: '',
    };
    expect(textDraftToModel(d)).toEqual({ filterType: 'text', type: 'contains', filter: '銀行' });
  });
});

describe('modelToTextDraft（重開還原）', () => {
  it('單一 equals → type1/filter1，type2=none', () => {
    expect(modelToTextDraft({ filterType: 'text', type: 'equals', filter: '現金' })).toEqual({
      ...EMPTY_TEXT_DRAFT,
      type1: 'equals',
      filter1: '現金',
    });
  });
  it('CombinedFilter → 兩條件草稿', () => {
    expect(
      modelToTextDraft({
        filterType: 'text',
        operator: 'OR',
        conditions: [
          { filterType: 'text', type: 'startsWith', filter: '銀' },
          { filterType: 'text', type: 'endsWith', filter: '入' },
        ],
      }),
    ).toEqual({ type1: 'startsWith', filter1: '銀', join: 'OR', type2: 'endsWith', filter2: '入' });
  });
  it('set / null → 空草稿', () => {
    expect(modelToTextDraft(null)).toEqual(EMPTY_TEXT_DRAFT);
    expect(modelToTextDraft({ filterType: 'set', values: ['x'], includeBlanks: false })).toEqual(
      EMPTY_TEXT_DRAFT,
    );
  });
});

describe('viewToModel（套用單一出口）', () => {
  const all = ['現金', '銀行存款'];
  it('list 模式委派 listToModel', () => {
    expect(viewToModel('list', new Set(all), EMPTY_TEXT_DRAFT, all)).toBeNull();
    expect(viewToModel('list', new Set(['現金']), EMPTY_TEXT_DRAFT, all)).toEqual({
      filterType: 'set',
      values: ['現金'],
      includeBlanks: false,
    });
  });
  it('text 模式委派 textDraftToModel', () => {
    const d: TextDraft = { ...EMPTY_TEXT_DRAFT, type1: 'contains', filter1: '銀行' };
    expect(viewToModel('text', new Set(), d, all)).toEqual({
      filterType: 'text',
      type: 'contains',
      filter: '銀行',
    });
  });
});

it('keeps literal column values distinct from the blank checkbox', () => {
  const values = [BLANK_KEY, '\u0000x'];
  const checked = new Set(values.map(listKey));
  expect(listToModel(checked, [])).toEqual({filterType: 'set', values, includeBlanks: false});
});
