/**
 * Capitalizing keywords as you type them.
 *
 * Type `select` and the moment you finish the word — a space, a comma, a
 * newline, anything that is not part of it — it becomes `SELECT`. HeidiSQL does
 * this and it is the reason people's scripts are shouty without anyone ever
 * holding shift.
 *
 * Two things make it safe rather than annoying.
 *
 * It only ever fires on a word you have just finished typing, so it never
 * reaches back and rewrites something you left alone, and it never touches a
 * word while the caret is still inside it.
 *
 * And it asks the syntax tree first. `select` inside a string, a comment or a
 * quoted identifier is not a keyword, it is someone's data, and rewriting it
 * would change what the statement means. Same for a word after a dot: in
 * `orders.order` that second half is a column, whatever it is spelled like.
 *
 * The rewrite rides along in the same transaction as the keystroke, so one
 * Ctrl+Z takes back the capital and the letter together rather than leaving you
 * to press it twice.
 */

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { KEYWORDS } from '../shared/sqlformat.js';

/** The word immediately before a position, if there is one. */
const TRAILING_WORD = /[A-Za-z_][A-Za-z0-9_]*$/;

const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);

/**
 * Characters that mean the word after them is not a keyword: a qualified name,
 * a quoted identifier, a bind parameter, a MySQL variable.
 */
const NOT_A_KEYWORD_AFTER = new Set(['.', '"', '`', '[', '@', ':', '$']);

/** Tree nodes whose text is not code, however much it looks like it. */
const NOT_CODE = /String|Comment|Quoted|Escape/i;

function insideText(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node) {
    if (NOT_CODE.test(node.name)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * The single character just typed, or null for anything else — a paste, a
 * multi-cursor edit, an undo, a programmatic replacement.
 */
function typedChar(tr) {
  if (!tr.docChanged || !tr.isUserEvent('input.type')) return null;
  let found = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    count += 1;
    if (inserted.length === 1) found = { at: fromA, ch: inserted.sliceString(0) };
  });
  return count === 1 && found ? found : null;
}

export const capitalizeKeywordsAsYouType = EditorState.transactionFilter.of((tr) => {
  const typed = typedChar(tr);
  // Still inside the word — nothing has been finished yet.
  if (!typed || isWordChar(typed.ch)) return tr;

  const { doc } = tr.startState;
  const before = doc.sliceString(Math.max(0, typed.at - 64), typed.at);
  const m = TRAILING_WORD.exec(before);
  if (!m) return tr;

  const word = m[0];
  const upper = word.toUpperCase();
  if (word === upper) return tr;
  if (!KEYWORDS.has(word.toLowerCase())) return tr;

  const start = typed.at - word.length;
  if (start > 0 && NOT_A_KEYWORD_AFTER.has(doc.sliceString(start - 1, start))) return tr;
  if (insideText(tr.startState, start)) return tr;

  // Positions in the document this transaction produces, which is what
  // `sequential` means. The replacement is the same length as what it replaces,
  // so the caret does not move.
  return [tr, {
    changes: {
      from: tr.changes.mapPos(start, -1),
      to: tr.changes.mapPos(typed.at, -1),
      insert: upper,
    },
    sequential: true,
  }];
});
