'use strict';

/**
 * Every menu command, in one place.
 *
 * The main process builds the Electron menu from this (which is what registers
 * the keyboard accelerators, even though the window is frameless and never
 * draws a menu bar), and the renderer builds the in-app menu from the same
 * tree. Defining it twice is how a menu item ends up doing nothing.
 *
 * `id` is the string sent to the renderer's command handler. `role` is an
 * Electron role handled in the main process instead. A bare `{ sep: true }`
 * is a separator.
 */

const MENU = [
  {
    label: 'File',
    items: [
      { id: 'connection:new', label: 'New Connection…', accel: 'CmdOrCtrl+N' },
      { id: 'connection:manage', label: 'Manage Connections…', accel: 'CmdOrCtrl+Shift+O' },
      { id: 'connection:switch', label: 'Switch Connection…', accel: 'CmdOrCtrl+K' },
      { sep: true },
      { id: 'tab:new', label: 'New Query Tab', accel: 'CmdOrCtrl+T' },
      { id: 'tab:close', label: 'Close Tab', accel: 'CmdOrCtrl+W' },
      { sep: true },
      { id: 'file:open', label: 'Open SQL File…', accel: 'CmdOrCtrl+O' },
      { id: 'file:save', label: 'Save SQL As…', accel: 'CmdOrCtrl+S' },
      { sep: true },
      { role: 'quit', label: 'Quit', mac: false },
      // Cmd+W closes the tab here, as it does in a browser; the window gets
      // the shifted one rather than fighting over it.
      { role: 'close', label: 'Close Window', accel: 'CmdOrCtrl+Shift+W', mac: true },
    ],
  },
  {
    label: 'Edit',
    items: [
      { role: 'undo', label: 'Undo', accel: 'CmdOrCtrl+Z' },
      { role: 'redo', label: 'Redo', accel: 'CmdOrCtrl+Shift+Z' },
      { sep: true },
      { role: 'cut', label: 'Cut', accel: 'CmdOrCtrl+X' },
      { role: 'copy', label: 'Copy', accel: 'CmdOrCtrl+C' },
      { role: 'paste', label: 'Paste', accel: 'CmdOrCtrl+V' },
      { role: 'selectAll', label: 'Select All', accel: 'CmdOrCtrl+A' },
    ],
  },
  {
    label: 'Query',
    items: [
      { id: 'query:run', label: 'Run Current Statement', accel: 'CmdOrCtrl+Return' },
      { id: 'query:runAll', label: 'Run Whole Script', accel: 'CmdOrCtrl+Shift+Return' },
      { id: 'query:cancel', label: 'Cancel Running Query', accel: 'CmdOrCtrl+.' },
      { sep: true },
      { id: 'edit:format', label: 'Format Statement', accel: 'CmdOrCtrl+Shift+K' },
      { id: 'edit:formatAll', label: 'Format Whole Script', accel: 'CmdOrCtrl+Alt+K' },
      { sep: true },
      { id: 'perf:explain', label: 'Explain', accel: 'CmdOrCtrl+Shift+E' },
      { id: 'perf:explainAnalyze', label: 'Explain Analyze', accel: 'CmdOrCtrl+Alt+E' },
      { id: 'perf:benchmark', label: 'Benchmark Statements…', accel: 'CmdOrCtrl+Shift+B' },
      { sep: true },
      { id: 'grid:filter', label: 'Filter Rows…', accel: 'CmdOrCtrl+Shift+F' },
      { id: 'grid:clearFilters', label: 'Clear Filter' },
      { id: 'grid:columns', label: 'Choose Columns…' },
      { id: 'grid:inspect', label: 'Value Inspector', accel: 'CmdOrCtrl+I' },
      { sep: true },
      { id: 'grid:addRow', label: 'Add Row', accel: 'CmdOrCtrl+Shift+A' },
      // Not Ctrl+Backspace: that is delete-word-backwards in any text box,
      // and a grid shortcut is not worth breaking typing for.
      { id: 'grid:deleteRow', label: 'Delete Selected Rows', accel: 'CmdOrCtrl+Shift+Backspace' },
      { id: 'grid:commit', label: 'Commit Grid Changes', accel: 'CmdOrCtrl+Shift+S' },
      { id: 'grid:discard', label: 'Discard Grid Changes' },
      { sep: true },
      { id: 'result:export', label: 'Export Result…', accel: 'CmdOrCtrl+Shift+X' },
    ],
  },
  {
    label: 'Go',
    items: [
      { id: 'palette:tables', label: 'Quick Open Table…', accel: 'CmdOrCtrl+P' },
      { id: 'palette:commands', label: 'Command Palette…', accel: 'CmdOrCtrl+Shift+P' },
      { id: 'history:open', label: 'Query History…', accel: 'CmdOrCtrl+H' },
      { id: 'search:database', label: 'Find in Database…', accel: 'CmdOrCtrl+Shift+G' },
      { id: 'server:processes', label: 'Server Activity…', accel: 'CmdOrCtrl+Shift+L' },
      { id: 'server:health', label: 'Health & Memory…', accel: 'CmdOrCtrl+Shift+M' },
      { sep: true },
      { id: 'focus:editor', label: 'Focus Editor', accel: 'CmdOrCtrl+E' },
      { id: 'schema:refresh', label: 'Refresh Schema', accel: 'CmdOrCtrl+R' },
      { sep: true },
      { id: 'tab:next', label: 'Next Tab', accel: 'Ctrl+Tab' },
      { id: 'tab:prev', label: 'Previous Tab', accel: 'Ctrl+Shift+Tab' },
    ],
  },
  {
    label: 'View',
    items: [
      // Electron's reload role defaults to Ctrl+R, which is Refresh Schema here.
      { role: 'reload', label: 'Reload', accel: 'CmdOrCtrl+Alt+R' },
      { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
      { sep: true },
      { role: 'resetZoom', label: 'Actual Size' },
      { role: 'zoomIn', label: 'Zoom In' },
      { role: 'zoomOut', label: 'Zoom Out' },
      { sep: true },
      { role: 'togglefullscreen', label: 'Toggle Full Screen' },
    ],
  },
  {
    label: 'Help',
    items: [
      { id: 'help:whatsnew', label: "What's New" },
      { id: 'help:changelog', label: 'Version History' },
      { sep: true },
      { id: 'help:about', label: 'About Cobalt' },
    ],
  },
];

/** Groups for a platform, dropping items marked for the other one. */
function menuFor(platform) {
  const isMac = platform === 'darwin';
  return MENU.map((g) => ({
    ...g,
    items: g.items.filter((it) => it.mac === undefined || it.mac === isMac),
  }));
}

/** Every renderer-handled command id, for checking nothing is unwired. */
function commandIds() {
  const ids = [];
  for (const g of MENU) for (const it of g.items) if (it.id) ids.push(it.id);
  return ids;
}

/** Roles the in-app menu asks the main process to perform. */
function roleNames() {
  const roles = new Set();
  for (const g of MENU) for (const it of g.items) if (it.role) roles.add(it.role);
  return [...roles];
}

/** "CmdOrCtrl+Shift+F" -> "Ctrl+Shift+F" or "⌘⇧F". */
function formatAccel(accel, platform) {
  if (!accel) return '';
  const isMac = platform === 'darwin';
  if (!isMac) {
    return accel
      .replace(/CmdOrCtrl|CommandOrControl/g, 'Ctrl')
      .replace(/\bReturn\b/g, 'Enter')
      .replace(/\bAlt\b/g, 'Alt');
  }
  return accel
    .replace(/CmdOrCtrl|CommandOrControl|Cmd|Command/g, '⌘')
    .replace(/Shift/g, '⇧')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Ctrl|Control/g, '⌃')
    .replace(/\bReturn\b/g, '↩')
    .replace(/\bBackspace\b/g, '⌫')
    .replace(/\+/g, '');
}



/* ------------------------------------------------------------------ *
 * Accelerators versus the editor's own keymap
 *
 * CodeMirror handles keys in the renderer and consumes the ones its commands
 * take, which stops the menu accelerator ever firing. That is not a conflict
 * you can see by reading either list: Ctrl+Shift+L worked until you had text
 * selected, because only then did selectSelectionMatches claim it.
 *
 * So the editor is told which keys belong to the app, and drops its own
 * bindings for them. The exceptions are keys where the editing behaviour is
 * what anyone would expect in a text box — deleting a word backwards — and
 * there it is the app's accelerator that has to move instead.
 * ------------------------------------------------------------------ */

/** Keys the editor keeps even though the menu also wants them. */
const EDITOR_KEEPS = ['Mod-Backspace'];

/**
 * "CmdOrCtrl+Shift+K" and "Shift-Mod-k" both become "mod+shift|k", so the two
 * spellings can be compared at all.
 */
function canonicalKey(key) {
  const parts = String(key || '').split(/[+-]/).filter(Boolean);
  if (!parts.length) return '';
  const base = parts.pop().toLowerCase();
  const mods = new Set();
  for (const m of parts) {
    const v = m.toLowerCase();
    if (v === 'cmdorctrl' || v === 'commandorcontrol' || v === 'mod'
      || v === 'cmd' || v === 'command' || v === 'ctrl' || v === 'control' || v === 'meta') mods.add('mod');
    else if (v === 'shift') mods.add('shift');
    else if (v === 'alt' || v === 'option') mods.add('alt');
  }
  const named = { return: 'enter', esc: 'escape', del: 'delete' };
  return `${[...mods].sort().join('+')}|${named[base] || base}`;
}

/**
 * The canonical keys the app's own commands claim — roles are left out, since
 * Electron handles those and the editor should keep its normal behaviour for
 * copy, paste and select-all.
 */
function appAcceleratorKeys() {
  const keep = new Set(EDITOR_KEEPS.map(canonicalKey));
  const out = new Set();
  for (const g of MENU) {
    for (const it of g.items) {
      if (!it.id || !it.accel) continue;
      const k = canonicalKey(it.accel);
      if (!keep.has(k)) out.add(k);
    }
  }
  return out;
}

/**
 * Drop the bindings in a CodeMirror keymap that the app has claimed.
 *
 * A binding can claim two keys without spelling both: `{ key: "Mod-g", shift:
 * findPrevious }` handles Ctrl+G *and* Ctrl+Shift+G. So the shift variant is
 * checked separately, and when only that half collides the binding is kept
 * with its `shift` handler removed — taking the whole thing would cost you
 * Ctrl+G for the sake of Ctrl+Shift+G.
 */
function withoutAppKeys(bindings) {
  const claimed = appAcceleratorKeys();
  const out = [];
  for (const b of bindings) {
    const spellings = [b.key, b.win, b.linux].filter(Boolean);
    if (spellings.some((k) => claimed.has(canonicalKey(k)))) continue;

    if (b.shift && spellings.some((k) => claimed.has(canonicalKey(`Shift-${k}`)))) {
      const { shift, ...rest } = b;
      out.push(rest);
      continue;
    }
    out.push(b);
  }
  return out;
}

module.exports = {
  MENU, menuFor, commandIds, roleNames, formatAccel,
  canonicalKey, appAcceleratorKeys, withoutAppKeys, EDITOR_KEEPS,
};
