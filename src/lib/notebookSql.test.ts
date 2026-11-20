import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { duckDbDialect, notebookCompletion } from './notebookSql';
import type { NotebookSource, SqlVocabulary } from '../types/notebook';

const words: SqlVocabulary = {
  keywords: ['select', 'from', 'as', 'join', 'where', 'qualify'],
  types: ['integer'],
  functions: ['list_transform'],
  tableFunctions: ['read_parquet'],
};
const dialect = duckDbDialect(words);
const sources: NotebookSource[] = [
  {
    name: '01_sample',
    isSnapshot: false,
    columns: [{ name: '借方"金額', displayType: 'number', duckdbType: 'DECIMAL(18,2)' }],
  },
  {
    name: '旅費.核對',
    isSnapshot: true,
    columns: [{ name: '科目', displayType: 'text', duckdbType: 'VARCHAR' }],
  },
];
const complete = notebookCompletion(sources, dialect, words, {
  database: '資料庫',
  snapshot: '快照',
});
async function at(text: string, explicit = false) {
  const pos = text.indexOf('|');
  const doc = text.replace('|', '');
  const state = EditorState.create({ doc, extensions: [dialect.extension] });
  return await complete(new CompletionContext(state, pos, explicit));
}

describe('DuckDB editor', () => {
  it('highlights tokens using the bundled engine vocabulary', () => {
    expect(
      dialect.language.parser.parse(`QUALIFY list_transform(42, 'ok') -- note`).toString(),
    ).toMatch(/Keyword,Builtin,Parens.*Number.*String.*LineComment/);
  });
  it('offers sources after FROM and JOIN, and safely quotes names', async () => {
    for (const sql of ['SELECT * FROM |', 'FROM 01|', 'FROM "01_sample" h JOIN |']) {
      const res = await at(sql);
      expect(res?.options.find((o) => o.label === '旅費.核對')).toMatchObject({
        apply: '"旅費.核對"',
        detail: '快照',
      });
      expect(res?.options.some((o) => o.label === 'read_parquet')).toBe(true);
      expect(res?.options.some((o) => o.label === 'QUALIFY')).toBe(false);
    }
  });
  it('resolves a qualified column in this statement, also before the FROM clause', async () => {
    for (const sql of [
      'SELECT H.| FROM "01_sample" AS h',
      'FROM "01_sample" h WHERE h.|',
      'SELECT * FROM "旅費.核對" x JOIN "01_sample" h ON h.|',
    ]) {
      const res = await at(sql);
      expect(res?.options).toHaveLength(1);
      expect(res?.options[0]).toMatchObject({
        label: '借方"金額',
        apply: '"借方""金額"',
        detail: 'DECIMAL(18,2)',
      });
    }
    expect(await at('FROM "01_sample" h; SELECT h.|')).toBeNull();
  });
  it('replaces an existing quoted identifier and completes Unicode prefixes', async () => {
    const sql = 'FROM "01_sample" h WHERE h."借|方"';
    const res = await at(sql);
    expect(res?.options[0].apply).toBe('借方""金額"');
    expect(sql.replace('|', '').slice(res!.from, res!.to)).toBe('借方"');
    expect(res?.filter).toBe(false);
    const beforeName = 'FROM "01_sample" h WHERE h.|"舊欄位"';
    const replacement = await at(beforeName, true);
    expect(beforeName.replace('|', '').slice(replacement!.from, replacement!.to)).toBe('"舊欄位"');
    expect(replacement?.options[0].apply).toBe('"借方""金額"');
    expect(
      (await at('FROM "旅費.核對" x WHERE 科|'))?.options.some((o) => o.label === '科目'),
    ).toBe(true);
  });
  it('offers keywords and functions, and suppresses hints inside literals and comments', async () => {
    expect((await at('QUA|'))?.options.some((o) => o.label === 'QUALIFY')).toBe(true);
    expect(
      (await at('SELECT list_tr|'))?.options.find((o) => o.label === 'list_transform')?.type,
    ).toBe('function');
    for (const sql of [
      "SELECT 'te|xt'",
      'SELECT $$str|$$',
      'SELECT 1 -- hi|',
      'SELECT /* a|b */ 1',
    ])
      expect(await at(sql, true)).toBeNull();
  });
});
