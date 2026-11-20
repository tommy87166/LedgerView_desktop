import {
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { SQLDialect, StandardSQL, keywordCompletionSource } from '@codemirror/lang-sql';
import type { Extension, EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { NotebookSource, SqlVocabulary } from '../types/notebook';

export function quoteSqlName(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}

export function duckDbDialect(words: SqlVocabulary): SQLDialect {
  const special = new Set(['true', 'false', 'null', 'unknown']);
  const keywords = words.keywords.filter((word) => !special.has(word));
  const syntaxWords = new Set([...keywords, ...words.types, ...special]);
  return SQLDialect.define({
    keywords: keywords.join(' '),
    types: words.types.join(' '),
    builtin: [...words.functions, ...words.tableFunctions]
      .filter((word) => !syntaxWords.has(word))
      .join(' '),
    caseInsensitiveIdentifiers: true,
    doubleDollarQuotedStrings: true,
    operatorChars: '+-*/<>=~!@#%^&|:',
  });
}

interface Token {
  kind: string;
  text: string;
  from: number;
  to: number;
}

// Work inside the current SELECT. Parenthesized expressions share its sources;
// a nested SELECT has its own FROM/JOIN bindings.
function queryScope(state: EditorState, pos: number, at: SyntaxNode) {
  for (let n: SyntaxNode | null = at; n; n = n.parent) {
    if (n.name === 'Statement') return n;
    if (n.name === 'Parens' && isSubquery(state, n)) return n;
  }
  const prev = syntaxTree(state).topNode.childBefore(pos);
  return prev?.name === 'Statement' && prev.lastChild?.name !== ';' ? prev : null;
}

function isSubquery(state: EditorState, n: SyntaxNode) {
  const keyword = n.getChild('Keyword');
  return keyword && /^(select|from|with|values)$/i.test(state.sliceDoc(keyword.from, keyword.to));
}

function queryTokens(state: EditorState, scope: SyntaxNode | null): Token[] {
  const tokens: Token[] = [];
  function walk(n: SyntaxNode) {
    if (n.type.isError || n.name.endsWith('Comment')) return;
    if (n.firstChild && !(n !== scope && n.name === 'Parens' && isSubquery(state, n))) {
      for (let child: SyntaxNode | null = n.firstChild; child; child = child.nextSibling)
        walk(child);
    } else {
      const text = n.firstChild ? '' : state.sliceDoc(n.from, n.to);
      const prev = tokens.at(-1);
      // The SQL tokenizer emits adjacent pieces for doubled identifier quotes.
      if (n.name === 'QuotedIdentifier' && prev?.kind === n.name && prev.to === n.from) {
        prev.text += text;
        prev.to = n.to;
      } else tokens.push({ kind: n.name, text, from: n.from, to: n.to });
    }
  }
  if (scope) walk(scope);
  return tokens;
}

function identifier(token?: Token) {
  if (!token) return '';
  return token.text.replace(/^"|"$/g, '').replaceAll('""', '"').toLowerCase();
}
const relationKeyword = (token?: Token) =>
  token?.kind === 'Keyword' && /^(from|join)$/i.test(token.text);

function sourceBindings(tokens: Token[], tables: Map<string, NotebookSource>) {
  const bindings = new Map<string, NotebookSource>();
  for (let i = 0; i < tokens.length; i++) {
    if (!relationKeyword(tokens[i])) continue;
    const table = tables.get(identifier(tokens[i + 1]));
    if (!table) continue;
    bindings.set(table.name.toLowerCase(), table);
    const explicit = /^as$/i.test(tokens[i + 2]?.text ?? '');
    const alias = tokens[i + (explicit ? 3 : 2)];
    if (alias && (explicit || /^(Identifier|QuotedIdentifier)$/.test(alias.kind))) {
      bindings.set(identifier(alias), table);
    }
  }
  return bindings;
}

export function notebookCompletion(
  sources: NotebookSource[],
  dialect: SQLDialect,
  words: SqlVocabulary | null,
  labels: { database: string; snapshot: string },
): CompletionSource {
  const tables = new Map(sources.map((s) => [s.name.toLowerCase(), s]));
  const tableOptions: Completion[] = sources.map((s) => ({
    label: s.name,
    apply: quoteSqlName(s.name),
    type: 'class',
    detail: s.isSnapshot ? labels.snapshot : labels.database,
    boost: 6,
  }));
  const fields = new Map(
    sources.map((s) => [
      s,
      (s.columns ?? []).map((c) => ({
        label: c.name,
        apply: quoteSqlName(c.name),
        detail: c.duckdbType,
        type: 'property',
        boost: 5,
      })),
    ]),
  );
  const tableFunctions = (words?.tableFunctions ?? []).map((label) => ({
    label,
    type: 'function',
  }));
  const functions = new Set([...(words?.functions ?? []), ...(words?.tableFunctions ?? [])]);
  const vocabulary = keywordCompletionSource(dialect, true, (label, type) => {
    const name = label.toLowerCase();
    return functions.has(name) && type === 'variable'
      ? { label: name, type: 'function' }
      : { label, type };
  });
  return (context: CompletionContext) => {
    const { state, pos } = context;
    const at = syntaxTree(state).resolveInner(pos, -1);
    if (/^(String|LineComment|BlockComment|Bytes|Bits)$/.test(at.name)) return null;
    const tokens = queryTokens(state, queryScope(state, pos, at));
    const current = tokens.find((t) => t.from < pos && t.to >= pos);
    const quoted = current?.kind === 'QuotedIdentifier';
    const prefix = context.matchBefore(/[\p{L}\p{M}\p{N}_$]+/u);
    const start = quoted ? current.from : (prefix?.from ?? pos);
    const before = tokens.filter((t) => t.to <= start);
    const prev = before.at(-1);
    const afterDot = prev?.kind === '.';
    const tablePosition = relationKeyword(prev);
    if (!quoted && !prefix && !context.explicit && !afterDot && !tablePosition) return null;

    const bindings = sourceBindings(tokens, tables);
    let options: Completion[];
    if (afterDot) {
      const parent = identifier(before.at(-2));
      const source = bindings.get(parent) ?? tables.get(parent);
      options = source ? fields.get(source)! : [];
    } else if (tablePosition) {
      options = quoted ? tableOptions : [...tableOptions, ...tableFunctions];
    } else {
      const columns = [...new Set(bindings.values())].flatMap((s) => fields.get(s)!);
      options = [...columns, ...tableOptions];
      // The dialect supplies the same keywords, types and function names used by the highlighter.
      const result = vocabulary(context);
      if (!quoted && result && 'options' in result) options.push(...result.options);
    }
    if (quoted) {
      // Keep the opening quote, replace the complete identifier including any closing quote.
      options = options.map((o) => ({ ...o, apply: quoteSqlName(o.label).slice(1) }));
    }
    if (!options.length) return null;
    const from = quoted ? start + 1 : start;
    const nextName = tokens.find((t) => t.from === pos && /^(QuotedIdentifier|Identifier)$/.test(t.kind));
    const to = current && (quoted || prefix) ? current.to : (nextName?.to ?? pos);
    if (to > pos) {
      // CodeMirror filters the whole replacement range. Only the typed prefix should
      // filter suggestions when replacing text to the right of the cursor.
      const typed = state.sliceDoc(from, pos).replaceAll('""', '"').toLowerCase();
      options = options.filter((o) => o.label.toLowerCase().startsWith(typed));
      return options.length ? { from, to, options, filter: false } : null;
    }
    return { from, to, options };
  };
}

export function notebookLanguage(
  sources: NotebookSource[],
  words: SqlVocabulary | null,
  labels: { database: string; snapshot: string },
): Extension {
  const dialect = words ? duckDbDialect(words) : StandardSQL;
  return [
    dialect.extension,
    dialect.language.data.of({ autocomplete: notebookCompletion(sources, dialect, words, labels) }),
  ];
}
