'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Unwrap the {ok, value|error} envelope from main into a normal promise. */
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((res) => {
  if (res && res.ok) return res.value;
  const err = new Error((res && res.error && res.error.message) || 'Unknown error');
  if (res && res.error) Object.assign(err, res.error);
  throw err;
});

contextBridge.exposeInMainWorld('cobalt', {
  connections: {
    list: () => call('conn:list'),
    save: (record) => call('conn:save', record),
    remove: (id) => call('conn:delete', id),
    duplicate: (id) => call('conn:duplicate', id),
    reorder: (ids) => call('conn:reorder', ids),
    test: (record) => call('conn:test', record),
    open: (savedId, overrides) => call('conn:open', savedId, overrides),
    close: (id) => call('conn:close', id),
    schema: (id) => call('conn:schema', id),
    ddl: (id, schema, table) => call('conn:ddl', id, schema, table),
    stats: (id, schema, table) => call('conn:stats', id, schema, table),
  },
  query: {
    run: (id, tabKey, sql, opts) => call('query:run', id, tabKey, sql, opts),
    filter: (id, tabKey, baseSql, filters, opts) => call('query:filter', id, tabKey, baseSql, filters, opts),
    cancel: (id, tabKey) => call('query:cancel', id, tabKey),
    release: (id, tabKey) => call('query:release', id, tabKey),
    apply: (id, change) => call('grid:apply', id, change),
  },
  app: {
    info: () => call('app:info'),
    unseenReleases: () => call('app:unseenReleases'),
  },
  workspace: {
    get: () => call('ws:get'),
    set: (ws) => call('ws:set', ws),
  },
  files: {
    open: () => call('file:open'),
    save: (name, text) => call('file:save', name, text),
    saveCsv: (name, text) => call('file:saveCsv', name, text),
  },
  ui: {
    confirm: (opts) => call('dialog:confirm', opts),
    copy: (text) => call('clipboard:write', text),
    onMenu: (fn) => {
      const listener = (_e, cmd) => fn(cmd);
      ipcRenderer.on('menu', listener);
      return () => ipcRenderer.removeListener('menu', listener);
    },
  },
  platform: process.platform,
});
