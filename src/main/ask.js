'use strict';

const { dialog, ipcMain } = require('electron');

/**
 * The main process has questions too — an update is ready, a check failed —
 * and a Windows message box for those looks just as out of place as it did
 * everywhere else. So it asks the renderer to draw the question instead.
 *
 * The catch is that the renderer might not be there: the window can be closing,
 * the page can still be loading, or an older build might not know the message.
 * A question that silently never gets asked is worse than an ugly one, so this
 * waits briefly for the renderer to *acknowledge* and falls back to the native
 * box if it does not.
 *
 * The acknowledgement is separate from the answer on purpose. Waiting for the
 * answer with a timeout would mean popping a second, native copy over the top
 * of a question the person was still reading.
 */

const ACK_MS = 1200;

let seq = 0;
const acks = new Map();
const answers = new Map();

ipcMain.on('ui:ask:ack', (_e, id) => {
  const fn = acks.get(id);
  if (fn) { acks.delete(id); fn(); }
});

ipcMain.on('ui:ask:reply', (_e, id, answer) => {
  const fn = answers.get(id);
  if (fn) { answers.delete(id); fn(!!answer); }
});

function native(win, { title, message, detail, confirmLabel, cancelLabel, destructive, okOnly }) {
  const buttons = okOnly ? ['OK'] : [confirmLabel || 'OK', cancelLabel || 'Cancel'];
  const opts = {
    type: destructive ? 'warning' : 'question',
    buttons,
    defaultId: 0,
    cancelId: okOnly ? 0 : 1,
    title: title || 'Cobalt',
    message: message || '',
    detail: detail || undefined,
  };
  const done = (r) => r.response === 0;
  return win && !win.isDestroyed()
    ? dialog.showMessageBox(win, opts).then(done)
    : dialog.showMessageBox(opts).then(done);
}

/** Resolves true if confirmed. `okOnly` questions always resolve true. */
function ask(win, opts = {}) {
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (!wc || wc.isDestroyed() || wc.isLoading()) return native(win, opts);

  const id = `ask${++seq}`;
  return new Promise((resolve) => {
    let settled = false;
    const onClosed = () => finish(false);
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      acks.delete(id);
      answers.delete(id);
      // Each question adds a listener; leaving them on would trip Node's
      // max-listeners warning after a dozen of them in one session.
      win.removeListener('closed', onClosed);
      resolve(answer);
    };

    const timer = setTimeout(() => {
      if (settled || !acks.has(id)) return;
      acks.delete(id);
      answers.delete(id);
      // Nobody is listening over there. Ask the old way rather than not at all.
      native(win, opts).then(finish);
    }, ACK_MS);

    acks.set(id, () => clearTimeout(timer));
    answers.set(id, finish);
    // If the window dies mid-question, the promise must still settle.
    win.once('closed', onClosed);

    try {
      wc.send('ui:ask', { ...opts, id });
    } catch {
      clearTimeout(timer);
      native(win, opts).then(finish);
    }
  });
}

/** A statement rather than a question: one button, and nothing to decide. */
const tell = (win, opts) => ask(win, { confirmLabel: 'OK', ...opts, okOnly: true });

module.exports = { ask, tell };
