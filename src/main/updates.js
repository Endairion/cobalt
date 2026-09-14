'use strict';

const { dialog, shell } = require('electron');

/**
 * Updating without uninstalling.
 *
 * Two things make that true, and only one of them is code.
 *
 * The installer is NSIS, and NSIS upgrades in place: running a newer
 * Cobalt-Setup over an existing install replaces the program files and leaves
 * `userData` — saved connections, workspace, query history — alone. That works
 * whether or not anything below ever runs.
 *
 * What this adds is not having to go and look. It asks GitHub Releases whether
 * there is a newer version, downloads it in the background, and installs it on
 * quit. Nothing is installed behind your back mid-session: the swap happens
 * when the app is closing anyway, which is also the only moment it can safely
 * replace its own files on Windows.
 *
 * `electron-updater` is loaded lazily because it is only meaningful in a
 * packaged build — in development there is no installer to replace.
 */

let autoUpdater = null;
let state = { checking: false, available: null, downloaded: null, error: null };

function load() {
  if (autoUpdater) return autoUpdater;
  // eslint-disable-next-line global-require
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  // The install is deferred to quit, so it never interrupts a query.
  autoUpdater.autoInstallOnAppQuit = true;
  return autoUpdater;
}

/**
 * `interactive` means a person asked, so say something either way. The
 * automatic check on startup stays quiet unless there is news.
 */
function wire(win, { interactive }) {
  const up = load();
  up.removeAllListeners();

  up.on('error', (err) => {
    state.checking = false;
    state.error = err && err.message ? err.message : String(err);
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Could not check for updates',
        message: 'Cobalt could not reach the update feed.',
        detail: state.error,
        buttons: ['OK'],
      });
    }
  });

  up.on('update-not-available', (info) => {
    state.checking = false;
    state.available = null;
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Up to date',
        message: `Cobalt ${info && info.version ? info.version : ''} is the latest version.`,
        buttons: ['OK'],
      });
    }
  });

  up.on('update-available', (info) => {
    state.checking = false;
    state.available = info.version;
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', { kind: 'downloading', version: info.version });
    }
  });

  up.on('download-progress', (p) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', { kind: 'progress', percent: Math.round(p.percent) });
    }
  });

  up.on('update-downloaded', async (info) => {
    state.downloaded = info.version;
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', { kind: 'ready', version: info.version });
    }
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Cobalt ${info.version} is ready to install.`,
      detail: 'It will be installed over the current version when you quit — '
        + 'your connections and open tabs are kept. Restart now to get it straight away.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) up.quitAndInstall();
  });

  return up;
}

/** Called from the Help menu. */
async function checkForUpdates(win, { interactive = true } = {}) {
  const { app } = require('electron');
  if (!app.isPackaged) {
    if (interactive) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Not an installed copy',
        message: 'This is a development build, so there is nothing to update.',
        detail: 'Run `npm run dist` to build an installer, or install Cobalt from one '
          + 'and updates will be offered here.',
        buttons: ['OK'],
      });
    }
    return;
  }
  try {
    state.checking = true;
    state.error = null;
    await wire(win, { interactive }).checkForUpdates();
  } catch (err) {
    state.checking = false;
    state.error = err.message;
    if (interactive) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Could not check for updates',
        message: err.message,
        buttons: ['OK'],
      });
    }
  }
}

/**
 * The quiet check a little after launch. Deliberately delayed: starting a
 * download while the window is still opening connections helps nobody.
 */
function checkOnStartup(win, delayMs = 8000) {
  const { app } = require('electron');
  if (!app.isPackaged) return;
  setTimeout(() => { checkForUpdates(win, { interactive: false }).catch(() => {}); }, delayMs);
}

/** Where to go when automatic updates are not an option. */
function openReleasesPage() {
  return shell.openExternal('https://github.com/Endairion/cobalt/releases');
}

const status = () => ({ ...state });

module.exports = { checkForUpdates, checkOnStartup, openReleasesPage, status };
