'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Manager } = require('./db');
const { Store } = require('./store');

const isMac = process.platform === 'darwin';
const manager = new Manager();
let store = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161c',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // A long query must keep ticking while the window sits behind something else.
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  if (process.argv.includes('--dev') || smokeTarget()) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = ['LOG', 'WARN', 'ERROR'][level - 0] || 'LOG';
      console.log(`[renderer ${tag}] ${message}  (${source}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
  }
  if (smokeTarget()) runSmoke(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

const send = (cmd) => win && win.webContents.send('menu', cmd);

/* Smoke mode: `--smoke=out.png[,cmd1,cmd2]` boots the UI, optionally fires menu
   commands, writes a screenshot and exits. Used by test/smoke.js. */
function smokeTarget() {
  const arg = process.argv.find((a) => a.startsWith('--smoke='));
  return arg ? arg.slice('--smoke='.length) : null;
}

async function runSmoke(w) {
  const [out, ...cmds] = smokeTarget().split(',');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const untilReady = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await w.webContents.executeJavaScript('document.body.dataset.ready === "1"');
      if (ready) return true;
      await wait(120);
    }
    return false;
  };
  w.webContents.once('did-finish-load', async () => {
    try {
      if (!await untilReady(25000)) throw new Error('renderer never reported ready');
      for (const c of cmds) { send(c); await wait(1200); }
      // Optional DOM-level step for interactions no menu command covers.
      const jsArg = process.argv.find((a) => a.startsWith('--smoke-js='));
      if (jsArg) {
        const out = await w.webContents.executeJavaScript(jsArg.slice('--smoke-js='.length));
        if (out !== undefined) console.log(`[smoke] js ${JSON.stringify(out)}`);
        await wait(1500);
      }
      // An unfocused window stops producing frames, so capturePage would return a
      // stale one: pump two animation frames and confirm the DOM settled first.
      await w.webContents.executeJavaScript(
        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))'
      );
      await wait(400);
      const img = await w.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const snap = await w.webContents.executeJavaScript('JSON.stringify(window.__cobalt())');
      console.log(`[smoke] state ${snap}`);
      console.log(`[smoke] wrote ${out}`);
    } catch (err) {
      console.log(`[smoke] failed: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await manager.closeAll();
      app.exit(process.exitCode || 0);
    }
  });
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+N', click: () => send('connection:new') },
        { label: 'New Query Tab', accelerator: 'CmdOrCtrl+T', click: () => send('tab:new') },
        { type: 'separator' },
        { label: 'Open SQL File…', accelerator: 'CmdOrCtrl+O', click: () => send('file:open') },
        { label: 'Save SQL As…', accelerator: 'CmdOrCtrl+S', click: () => send('file:save') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('tab:close') },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Current Statement', accelerator: 'CmdOrCtrl+Return', click: () => send('query:run') },
        { label: 'Run Whole Script', accelerator: 'CmdOrCtrl+Shift+Return', click: () => send('query:runAll') },
        { label: 'Cancel Running Query', accelerator: 'CmdOrCtrl+.', click: () => send('query:cancel') },
        { type: 'separator' },
        { label: 'Commit Grid Changes', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('grid:commit') },
        { label: 'Discard Grid Changes', click: () => send('grid:discard') },
        { type: 'separator' },
        { label: 'Add Row', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('grid:addRow') },
        { label: 'Delete Selected Rows', accelerator: 'CmdOrCtrl+Backspace', click: () => send('grid:deleteRow') },
        { type: 'separator' },
        { label: 'Filter Results', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('grid:filter') },
        { label: 'Clear Filters', click: () => send('grid:clearFilters') },
        { type: 'separator' },
        { label: 'Export Result as CSV…', click: () => send('result:csv') },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Quick Open Table…', accelerator: 'CmdOrCtrl+P', click: () => send('palette:tables') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('palette:commands') },
        { label: 'Focus Editor', accelerator: 'CmdOrCtrl+E', click: () => send('focus:editor') },
        { label: 'Refresh Schema', accelerator: 'CmdOrCtrl+R', click: () => send('schema:refresh') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('tab:next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('tab:prev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------- IPC ---------------------------- */

const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try {
    return { ok: true, value: await fn(...args) };
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : null,
        detail: err && err.detail ? err.detail : null,
        hint: err && err.hint ? err.hint : null,
        position: err && err.position ? Number(err.position) : null,
        pgError: err && err.pgError ? err.pgError : null,
      },
    };
  }
});

handle('conn:list', () => store.list());
handle('conn:save', (record) => store.upsert(record));
handle('conn:delete', (id) => { store.remove(id); return true; });

handle('conn:test', async (record) => {
  const cfg = { ...record };
  // A blank password field on a saved connection means "reuse the stored one".
  if (record.savedId && !cfg.password) {
    const saved = store.resolve(record.savedId);
    if (saved) cfg.password = saved.password;
  }
  const res = await manager.open(cfg);
  await manager.close(res.id);
  return { serverVersion: res.serverVersion, database: res.database };
});

handle('conn:open', async (savedId, overrides) => {
  const saved = store.resolve(savedId);
  if (!saved) throw new Error('Saved connection not found.');
  const cfg = { ...saved, ...(overrides || {}) };
  if (!cfg.password && overrides && overrides.password) cfg.password = overrides.password;
  const info = await manager.open(cfg);
  return { ...info, savedId, name: saved.name, color: saved.color, readOnly: saved.readOnly };
});

handle('conn:close', (id) => manager.close(id));
handle('conn:schema', (id) => manager.schemaTree(id));
handle('conn:ddl', (id, schema, table) => manager.tableDdl(id, schema, table));
handle('conn:stats', (id, schema, table) => manager.tableStats(id, schema, table));

handle('query:run', (id, tabKey, sql, opts) => manager.run(id, tabKey, sql, opts || {}));
handle('query:filter', (id, tabKey, baseSql, filters, opts) => manager.runFiltered(id, tabKey, baseSql, filters, opts || {}));
handle('query:cancel', (id, tabKey) => manager.cancel(id, tabKey));
handle('query:release', (id, tabKey) => manager.releaseTab(id, tabKey));
handle('grid:apply', (id, change) => manager.applyChanges(id, change));

handle('ws:get', () => store.getWorkspace());
handle('ws:set', (ws) => { store.setWorkspace(ws); return true; });

handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true; });

handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
});

handle('file:save', async (suggestedName, text) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'query.sql',
    filters: [{ name: 'SQL', extensions: ['sql'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});

handle('file:saveCsv', async (suggestedName, text) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName || 'result.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, '﻿' + text, 'utf8');
  return r.filePath;
});

handle('dialog:confirm', async ({ title, message, detail, confirmLabel, destructive }) => {
  const r = await dialog.showMessageBox(win, {
    type: destructive ? 'warning' : 'question',
    buttons: [confirmLabel || 'OK', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: title || 'Cobalt',
    message: message || '',
    detail: detail || undefined,
  });
  return r.response === 0;
});

/* --------------------------- lifecycle --------------------------- */

app.whenReady().then(() => {
  store = new Store('cobalt-connections.json');
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await manager.closeAll();
  if (!isMac) app.quit();
});

app.on('before-quit', async () => { await manager.closeAll(); });
