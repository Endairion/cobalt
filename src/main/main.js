'use strict';

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Manager } = require('./db');
const { Store } = require('./store');
const { History } = require('./history');
const changelog = require('../shared/changelog');
const pkg = require('../../package.json');
const { menuFor, roleNames } = require('../shared/commands');

const isMac = process.platform === 'darwin';
const manager = new Manager();
let store = null;
let history = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161c',
    // macOS keeps its traffic lights (inset into our own chrome); everywhere else
    // the window is frameless and draws its own controls in the tab strip.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    frame: isMac,
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
  win.once('ready-to-show', () => {
    if (smokeTarget()) showQuietly(win);
    else win.show();
  });

  const pushWindowState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window:state', {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      focused: win.isFocused(),
    });
  };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    win.on(ev, pushWindowState);
  }
  win.webContents.on('did-finish-load', pushWindowState);
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

/**
 * Test runs should not interrupt whoever is using the machine: put the window
 * on a second display when there is one, keep it out of the taskbar, and show
 * it without taking focus. It still has to be shown and composited, because a
 * hidden window stops producing frames and capturePage would return a stale one.
 */
function showQuietly(w) {
  try {
    const primary = screen.getPrimaryDisplay();
    const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
    if (other) {
      const [width, height] = w.getSize();
      const area = other.workArea;
      w.setBounds({
        x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
        y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
        width: Math.min(width, area.width),
        height: Math.min(height, area.height),
      });
    }
    w.setSkipTaskbar(true);
  } catch { /* placement is a nicety, never fail the run over it */ }
  w.showInactive();
}

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
      // Optional real key presses, to prove accelerators reach the app.
      const keysArg = process.argv.find((a) => a.startsWith('--smoke-keys='));
      if (keysArg) {
        w.focus();
        await wait(300);
        for (const combo of keysArg.slice('--smoke-keys='.length).split(',')) {
          const parts = combo.split('+');
          const keyCode = parts.pop();
          const modifiers = parts.map((m) => m.toLowerCase());
          w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
          w.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
          w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          await wait(900);
        }
      }

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

/**
 * The window is frameless, so this menu is never drawn — but setting it is what
 * registers the keyboard accelerators. The in-app menu renders the same tree.
 */
function buildMenu() {
  const groups = menuFor(process.platform).map((g) => ({
    label: g.label,
    submenu: g.items.map((it) => {
      if (it.sep) return { type: 'separator' };
      if (it.role) return { role: it.role, label: it.label, ...(it.accel ? { accelerator: it.accel } : {}) };
      return {
        label: it.label,
        ...(it.accel ? { accelerator: it.accel } : {}),
        click: () => send(it.id),
      };
    }),
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    ...groups,
    { role: 'windowMenu' },
  ]));
}

const ROLES = new Set(roleNames());

/** The in-app menu asks for roles the renderer cannot perform itself. */
function performRole(role) {
  if (!ROLES.has(role) || !win) return false;
  const wc = win.webContents;
  switch (role) {
    case 'quit': app.quit(); break;
    case 'close': win.close(); break;
    case 'reload': wc.reload(); break;
    case 'toggleDevTools': wc.toggleDevTools(); break;
    case 'resetZoom': wc.setZoomLevel(0); break;
    case 'zoomIn': wc.setZoomLevel(Math.min(9, wc.getZoomLevel() + 0.5)); break;
    case 'zoomOut': wc.setZoomLevel(Math.max(-8, wc.getZoomLevel() - 0.5)); break;
    case 'togglefullscreen': win.setFullScreen(!win.isFullScreen()); break;
    case 'undo': wc.undo(); break;
    case 'redo': wc.redo(); break;
    case 'cut': wc.cut(); break;
    case 'copy': wc.copy(); break;
    case 'paste': wc.paste(); break;
    case 'selectAll': wc.selectAll(); break;
    default: return false;
  }
  return true;
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
handle('conn:duplicate', (id) => store.duplicate(id));
handle('conn:reorder', (ids) => store.reorder(ids));

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
  if (saved.passwordUnavailable && !(overrides && overrides.password)) {
    throw new Error(
      `The stored password for "${saved.name}" could not be decrypted. ` +
      'That happens when the app data folder is copied or restored without its Local State file, ' +
      'which holds the encryption key. Enter the password again to store a fresh one.'
    );
  }
  const cfg = { ...saved, ...(overrides || {}) };
  if (!cfg.password && overrides && overrides.password) cfg.password = overrides.password;
  const info = await manager.open(cfg);
  return { ...info, savedId, name: saved.name, color: saved.color, readOnly: saved.readOnly };
});

handle('conn:close', (id) => manager.close(id));
handle('conn:schema', (id) => manager.schemaTree(id));
handle('conn:fks', (id) => manager.foreignKeys(id));
handle('conn:ddl', (id, schema, table) => manager.tableDdl(id, schema, table));
handle('conn:runDdl', (id, sql) => manager.ddl(id, sql));
handle('conn:stats', (id, schema, table) => manager.tableStats(id, schema, table));

handle('query:run', (id, tabKey, sql, opts) => manager.run(id, tabKey, sql, opts || {}));
handle('query:page', (id, tabKey, baseSql, opts) => manager.runPaged(id, tabKey, baseSql, opts || {}));
handle('query:count', (id, tabKey, baseSql, filters, where) => manager.countRows(id, tabKey, baseSql, filters || [], where || ''));
handle('query:filter', (id, tabKey, baseSql, filters, opts) => manager.runFiltered(id, tabKey, baseSql, filters, opts || {}));
handle('perf:benchmark', (id, tabKey, variants, opts) => manager.benchmark(id, tabKey, variants, {
  ...(opts || {}),
  onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('perf:progress', p); },
}));
handle('perf:explain', (id, tabKey, sql, opts) => manager.explain(id, tabKey, sql, opts || {}));
handle('query:cancel', (id, tabKey) => manager.cancel(id, tabKey));
handle('query:release', (id, tabKey) => manager.releaseTab(id, tabKey));
handle('grid:apply', (id, change) => manager.applyChanges(id, change));

handle('window:minimize', () => { if (win) win.minimize(); return true; });
handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
handle('window:close', () => { if (win) win.close(); return true; });
handle('window:state', () => (win ? {
  maximized: win.isMaximized(), fullScreen: win.isFullScreen(), focused: win.isFocused(),
} : null));

handle('app:role', (role) => performRole(role));

handle('app:info', () => ({
  name: pkg.name,
  version: pkg.version,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  pg: (() => { try { return require('pg/package.json').version; } catch { return null; } })(),
  platform: `${process.platform} ${process.arch}`,
  releases: changelog.releases,
}));

/* The version whose notes have been seen, so a fresh build can show what changed
   exactly once. Reading it also marks the current version as seen. */
handle('app:unseenReleases', () => {
  const seen = store.getSeenVersion();
  store.setSeenVersion(pkg.version);
  if (!seen) return { from: null, releases: [] };          // first run: no catch-up
  if (changelog.compareVersions(seen, pkg.version) >= 0) return { from: seen, releases: [] };
  return { from: seen, releases: changelog.since(seen) };
});

handle('history:add', (entry) => history.append(entry));
handle('history:search', (opts) => history.search(opts || {}));
handle('history:stats', () => history.stats());
handle('history:clear', () => { history.clear(); return true; });

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
  history = new History(path.join(app.getPath('userData'), 'cobalt-history.jsonl'));
  try { history.trim(); } catch { /* a broken history file must not block startup */ }
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
