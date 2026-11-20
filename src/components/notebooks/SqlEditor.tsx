import { useLayoutEffect, useRef } from 'react';
import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, placeholder, tooltips } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { quoteSqlName } from '../../lib/notebookSql';
import type { NotebookSource } from '../../types/notebook';
import { NotebookSourcePicker } from './NotebookSourcePicker';

const fromProps = Annotation.define<boolean>();
const languageConfig = new Compartment();
const labelsConfig = new Compartment();
const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#6331a1', fontWeight: '600' },
  { tag: tags.standard(tags.name), color: '#005d74' },
  { tag: tags.typeName, color: '#8a3b68' },
  { tag: tags.string, color: '#22633b' },
  { tag: tags.special(tags.string), color: '#165b88' },
  { tag: [tags.number, tags.bool, tags.null], color: '#96520c' },
  { tag: tags.comment, color: '#657069', fontStyle: 'italic' },
  { tag: tags.operator, color: '#704a33' },
]);

function editorLabels(label: string, hint: string) {
  return [
    EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-multiline': 'true',
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
    placeholder(hint),
  ];
}

interface Props {
  sql: string;
  label: string;
  hint: string;
  language: Extension;
  sources: NotebookSource[];
  onChange: (sql: string) => void;
  onRun: (sql: string) => void;
}

export function SqlEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useLayoutEffect(() => {
    const initial = latest.current;
    const runQuery = (v: EditorView) => {
      if (v.composing) return false;
      latest.current.onRun(v.state.doc.toString());
      return true;
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial.sql,
        extensions: [
          languageConfig.of(initial.language),
          labelsConfig.of(editorLabels(initial.label, initial.hint)),
          syntaxHighlighting(sqlHighlight),
          EditorView.lineWrapping,
          bracketMatching(),
          history(),
          tooltips({ parent: document.body }),
          autocompletion(),
          keymap.of([
            { key: 'Ctrl-Enter', run: runQuery },
            { mac: 'Cmd-Enter', run: runQuery },
            { key: 'Tab', run: acceptCompletion },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromProps))) {
              latest.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: languageConfig.reconfigure(props.language) });
  }, [props.language]);
  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: labelsConfig.reconfigure(editorLabels(props.label, props.hint)),
    });
  }, [props.label, props.hint]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== props.sql) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.sql },
        annotations: [fromProps.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [props.sql]);

  function insertTable(name: string) {
    const view = editor.current;
    if (!view) return;
    const table = quoteSqlName(name);
    const blank = !view.state.doc.toString().trim();
    const insert = blank ? 'SELECT * FROM ' + table + ';' : table;
    const { from, to } = blank ? { from: 0, to: view.state.doc.length } : view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      userEvent: 'input.complete',
    });
    view.focus();
  }

  return (
    <>
      <div className="sql-editor" ref={host} />
      {props.sources.length > 0 && (
        <NotebookSourcePicker sources={props.sources} onPick={insertTable} />
      )}
    </>
  );
}
