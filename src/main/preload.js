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
    runDdl: (id, sql) => call('conn:runDdl', id, sql),
    importRows: (id, spec) => call('conn:import', id, spec),
    processList: (id) => call('conn:processList', id),
    serverStats: (id) => call('conn:serverStats', id),
    objects: (id) => call('conn:objects', id),
    search: (id, tabKey, opts) => call('conn:search', id, tabKey, opts),
    searchFilter: (id, opts) => call('conn:searchFilter', id, opts),
    killQuery: (id, pid, opts) => call('conn:killQuery', id, pid, opts),
    fks: (id) => call('conn:fks', id),
    stats: (id, schema, table) => call('conn:stats', id, schema, table),
  },
  query: {
    run: (id, tabKey, sql, opts) => call('query:run', id, tabKey, sql, opts),
    filter: (id, tabKey, baseSql, filters, opts) => call('query:filter', id, tabKey, baseSql, filters, opts),
    page: (id, tabKey, baseSql, opts) => call('query:page', id, tabKey, baseSql, opts),
    count: (id, tabKey, baseSql, filters, where) => call('query:count', id, tabKey, baseSql, filters, where),
    cancel: (id, tabKey) => call('query:cancel', id, tabKey),
    benchmark: (id, tabKey, variants, opts) => call('perf:benchmark', id, tabKey, variants, opts),
    explain: (id, tabKey, sql, opts) => call('perf:explain', id, tabKey, sql, opts),
    onBenchProgress: (fn) => {
      const listener = (_e, p) => fn(p);
      ipcRenderer.on('perf:progress', listener);
      return () => ipcRenderer.removeListener('perf:progress', listener);
    },
    release: (id, tabKey) => call('query:release', id, tabKey),
    apply: (id, change) => call('grid:apply', id, change),
  },
  window: {
    minimize: () => call('window:minimize'),
    toggleMaximize: () => call('window:toggleMaximize'),
    close: () => call('window:close'),
    state: () => call('window:state'),
    onState: (fn) => {
      const listener = (_e, st) => fn(st);
      ipcRenderer.on('window:state', listener);
      return () => ipcRenderer.removeListener('window:state', listener);
    },
  },
  app: {
    engines: () => call('app:engines'),
    checkUpdates: () => call('app:checkUpdates'),
    releasesPage: () => call('app:releasesPage'),
    updateStatus: () => call('app:updateStatus'),
    metrics: () => call('app:metrics'),
    info: () => call('app:info'),
    role: (name) => call('app:role', name),
    unseenReleases: () => call('app:unseenReleases'),
  },
  history: {
    add: (entry) => call('history:add', entry),
    search: (opts) => call('history:search', opts),
    stats: () => call('history:stats'),
    clear: () => call('history:clear'),
  },
  workspace: {
    get: () => call('ws:get'),
    set: (ws) => call('ws:set', ws),
  },
  files: {
    open: () => call('file:open'),
    save: (name, text) => call('file:save', name, text),
    saveCsv: (name, text) => call('file:saveCsv', name, text),
    saveText: (name, text, opts) => call('file:saveText', name, text, opts),
    openText: (opts) => call('file:openText', opts),
    pickFile: (opts) => call('file:pickFile', opts),
  },
  ui: {
    confirm: (opts) => call('dialog:confirm', opts),
    copy: (text) => call('clipboard:write', text),
    onUpdateStatus: (fn) => ipcRenderer.on('update:status', (_e, payload) => fn(payload)),
    onMenu: (fn) => {
      const listener = (_e, cmd) => fn(cmd);
      ipcRenderer.on('menu', listener);
      return () => ipcRenderer.removeListener('menu', listener);
    },
  },
  platform: process.platform,
});
