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
      { role: 'close', label: 'Close Window', mac: true },
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
      { id: 'perf:explain', label: 'Explain', accel: 'CmdOrCtrl+Shift+E' },
      { id: 'perf:explainAnalyze', label: 'Explain Analyze', accel: 'CmdOrCtrl+Alt+E' },
      { id: 'perf:benchmark', label: 'Benchmark Statements…', accel: 'CmdOrCtrl+Shift+B' },
      { sep: true },
      { id: 'grid:filter', label: 'Filter Results', accel: 'CmdOrCtrl+Shift+F' },
      { id: 'grid:clearFilters', label: 'Clear Filters' },
      { sep: true },
      { id: 'grid:addRow', label: 'Add Row', accel: 'CmdOrCtrl+Shift+A' },
      { id: 'grid:deleteRow', label: 'Delete Selected Rows', accel: 'CmdOrCtrl+Backspace' },
      { id: 'grid:commit', label: 'Commit Grid Changes', accel: 'CmdOrCtrl+Shift+S' },
      { id: 'grid:discard', label: 'Discard Grid Changes' },
      { sep: true },
      { id: 'result:csv', label: 'Export Result as CSV…' },
    ],
  },
  {
    label: 'Go',
    items: [
      { id: 'palette:tables', label: 'Quick Open Table…', accel: 'CmdOrCtrl+P' },
      { id: 'palette:commands', label: 'Command Palette…', accel: 'CmdOrCtrl+Shift+P' },
      { id: 'history:open', label: 'Query History…', accel: 'CmdOrCtrl+H' },
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
      { role: 'reload', label: 'Reload' },
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

module.exports = { MENU, menuFor, commandIds, roleNames, formatAccel };
