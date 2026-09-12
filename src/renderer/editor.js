import { EditorState, Compartment, StateField } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
  Decoration,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput,
  syntaxHighlighting, HighlightStyle,
} from '@codemirror/language';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { withoutAppKeys } from '../shared/commands.js';
import { tags as t } from '@lezer/highlight';
import { splitStatements } from '../main/sqlsplit.js';

const theme = EditorView.theme({
  '&': { color: '#d8dde8', backgroundColor: '#14161c', height: '100%' },
  '.cm-content': { caretColor: '#4c8dff', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#4c8dff', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(76,141,255,0.28)',
  },
  '.cm-gutters': { backgroundColor: '#14161c', color: '#4d5566', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: '#8b93a7' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(76,141,255,0.25)', outline: '1px solid rgba(76,141,255,0.6)',
  },
  '.cm-selectionMatch': { backgroundColor: 'rgba(176,124,240,0.22)' },
  '.cm-tooltip': { background: '#1d212b', border: '1px solid #343a4a', borderRadius: '8px' },
  '.cm-panels': { background: '#191c24', color: '#d8dde8' },
  '.cm-panels input': { background: '#101218', border: '1px solid #272c38', borderRadius: '5px', color: '#d8dde8' },
  '.cm-searchMatch': { backgroundColor: 'rgba(224,163,60,0.30)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(224,163,60,0.55)' },
}, { dark: true });

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7aa2f7', fontWeight: '600' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#d8dde8' },
  { tag: [t.propertyName], color: '#8fd0ff' },
  { tag: [t.string, t.special(t.string)], color: '#9ece6a' },
  { tag: [t.number, t.bool, t.null], color: '#e0a33c' },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.self, t.namespace], color: '#b07cf0' },
  { tag: [t.operator, t.operatorKeyword], color: '#46bfd0' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: '#5b6478', fontStyle: 'italic' },
  { tag: [t.meta], color: '#8b93a7' },
  { tag: t.invalid, color: '#f2695c' },
]);

/* Highlight the statement the caret is in, so "Run" is never a surprise. */
const stmtMark = Decoration.line({ class: 'cm-statement-active' });

const activeStatement = StateField.define({
  create: (state) => computeStatementDeco(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? computeStatementDeco(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

function computeStatementDeco(state) {
  const doc = state.doc.toString();
  if (!doc.trim()) return Decoration.none;
  const pos = state.selection.main.head;
  const stmts = splitStatements(doc);
  const hit = stmts.find((s) => pos >= s.start && pos <= s.end);
  if (!hit || stmts.length < 2) return Decoration.none;
  const builder = [];
  const from = state.doc.lineAt(Math.min(hit.start, doc.length)).number;
  const to = state.doc.lineAt(Math.min(Math.max(hit.end - 1, hit.start), doc.length)).number;
  for (let n = from; n <= to; n++) builder.push(stmtMark.range(state.doc.line(n).from));
  return Decoration.set(builder);
}

/* ------------------------------------------------------------------ */

export class SqlEditor {
  constructor(parent, { onChange, onRun, onRunAll, onCursor } = {}) {
    this.schemaCompartment = new Compartment();
    // Held outside the state so newly created tab states inherit the live schema.
    this.sqlConfig = { dialect: PostgreSQL, upperCaseKeywords: false };
    this.onChange = onChange || (() => {});
    this.onCursor = onCursor || (() => {});

    const runKeys = keymap.of([
      { key: 'Mod-Enter', preventDefault: true, run: () => { onRun && onRun(); return true; } },
      { key: 'Mod-Shift-Enter', preventDefault: true, run: () => { onRunAll && onRunAll(); return true; } },
    ]);

    this.extensions = () => [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 40, icons: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          syntaxHighlighting(highlight),
          activeStatement,
          runKeys,
          // Without the filter, CodeMirror silently eats the app's shortcuts:
          // it handles keys in the renderer and consumes the ones its own
          // commands take, so the menu accelerator never fires. Ctrl+Shift+L
          // worked until you had text selected, at which point
          // selectSelectionMatches claimed it.
          keymap.of([
            ...withoutAppKeys([
              ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
              ...historyKeymap, ...foldKeymap, ...completionKeymap,
            ]),
            indentWithTab,
          ]),
          this.schemaCompartment.of(sql(this.sqlConfig)),
          theme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.onChange(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) this.onCursor(this.cursorInfo());
          }),
    ];

    this.view = new EditorView({ parent, state: this.makeState('') });
  }

  /** A fresh document state; one per query tab, so each keeps its own undo stack. */
  makeState(doc) {
    return EditorState.create({ doc: doc || '', extensions: this.extensions() });
  }

  /** Swap in a tab's state. Returns the state being replaced so callers can stash it. */
  swapState(state) {
    const prev = this.view.state;
    this.view.setState(state);
    return prev;
  }

  get state() { return this.view.state; }

  cursorInfo() {
    const state = this.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const sel = state.selection.main;
    return {
      line: line.number,
      col: head - line.from + 1,
      selected: sel.to - sel.from,
      pos: head,
    };
  }

  /** Feed live schema into autocomplete. */
  setSchema(tree, defaultSchema = 'public') {
    const schema = {};
    const tables = [];
    if (tree && tree.schemas) {
      for (const s of tree.schemas) {
        for (const rel of s.relations) {
          const cols = rel.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type }));
          schema[`${s.name}.${rel.name}`] = cols;
          if (s.name === defaultSchema) schema[rel.name] = cols;
          tables.push({
            label: s.name === defaultSchema ? rel.name : `${s.name}.${rel.name}`,
            type: rel.kind === 'v' || rel.kind === 'm' ? 'class' : 'type',
            detail: s.name,
          });
        }
      }
    }
    this.sqlConfig = { dialect: PostgreSQL, schema, tables, defaultSchema, upperCaseKeywords: false };
    this.view.dispatch({ effects: this.schemaCompartment.reconfigure(sql(this.sqlConfig)) });
  }

  getValue() { return this.view.state.doc.toString(); }

  replaceAll(text, selectionPos) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: Math.min(selectionPos ?? text.length, text.length) },
    });
  }

  /** Select a range, for tests. */
  select(from, to) {
    const len = this.view.state.doc.length;
    this.view.dispatch({
      selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
    });
    this.focus();
  }

  /** Put the caret at an offset, for tests and for jumping to an error. */
  setCaret(pos) {
    const at = Math.max(0, Math.min(Number(pos) || 0, this.view.state.doc.length));
    this.view.dispatch({ selection: { anchor: at } });
  }

  /** Swap one span of the document, keeping the caret where it makes sense. */
  replaceRange(from, to, text) {
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    this.focus();
  }

  insertAtCursor(text) {
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    this.focus();
  }

  /** Statement under the caret, or the exact selection when there is one. */
  currentStatement() {
    const state = this.view.state;
    const sel = state.selection.main;
    if (sel.from !== sel.to) {
      return { sql: state.sliceDoc(sel.from, sel.to), start: sel.from, end: sel.to, fromSelection: true };
    }
    const doc = state.doc.toString();
    const stmts = splitStatements(doc);
    if (!stmts.length) return null;
    const head = sel.head;
    return stmts.find((s) => head >= s.start && head <= s.end) || stmts[stmts.length - 1];
  }

  statementCount() { return splitStatements(this.view.state.doc.toString()).length; }

  /** Split arbitrary text with the same rules the editor uses. */
  splitStatements(text) { return splitStatements(text); }

  /** Move the caret to a byte-ish offset inside a statement (for error positions). */
  highlightError(start, offsetInStatement) {
    const pos = Math.min(start + Math.max(0, offsetInStatement - 1), this.view.state.doc.length);
    this.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }

  focus() { this.view.focus(); }

  destroy() { this.view.destroy(); }
}
