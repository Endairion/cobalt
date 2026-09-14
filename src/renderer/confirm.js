/**
 * Asking a question, in the app's own voice.
 *
 * These used to be `dialog.showMessageBox`, which draws a Windows message box:
 * a different typeface, a different grey, buttons in the other order, and a
 * title bar naming the executable. It reads as though something has gone wrong
 * rather than as part of the app.
 *
 * What the native one genuinely gave us was modality and keyboard handling, so
 * this keeps both: a layer over the whole window, Enter answers yes, Escape
 * answers no, and a destructive question opens with Cancel focused so leaning
 * on the space bar cannot drop a table.
 *
 * It does not go through `showOverlay`, which holds one modal at a time. Half
 * these questions are asked *from* a modal — "run this ALTER TABLE?" from the
 * schema dialog — and reusing that slot would tear the dialog behind it down.
 * So each question gets its own layer above whatever is already there, and
 * they stack.
 *
 * File pickers stay native. Those are the operating system's job and there is
 * no honest way to replace them.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * ask({ title, message, detail, confirmLabel, cancelLabel, destructive, code, okOnly })
 * resolves true if confirmed and false otherwise — including Escape and the
 * backdrop, because every one of those means "no".
 */
export function ask({
  title = 'Cobalt',
  message = '',
  detail = '',
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  code = false,
  okOnly = false,
} = {}) {
  return new Promise((resolve) => {
    const returnTo = document.activeElement;
    let settled = false;

    const layer = document.createElement('div');
    layer.className = 'overlay ask-layer';
    layer.innerHTML = `
      <div class="modal ask-modal${destructive ? ' danger' : ''}" role="alertdialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        <div class="body">
          <div class="ask-message">${esc(message)}</div>
          ${detail ? `<div class="ask-detail${code ? ' code' : ''}">${esc(detail)}</div>` : ''}
        </div>
        <div class="foot">
          <span class="spacer"></span>
          ${okOnly ? '' : `<button class="btn ghost" data-ask="no">${esc(cancelLabel)}</button>`}
          <button class="btn ${destructive ? 'danger' : 'primary'}" data-ask="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;

    const finish = (answer) => {
      if (settled) return;
      settled = true;
      // Capture phase on `window`, so it runs before the handler `showOverlay`
      // put on `document` — otherwise Escape would close the dialog underneath
      // as well as this question.
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (returnTo && returnTo.isConnected && returnTo.focus) returnTo.focus();
      resolve(answer);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    };

    layer.addEventListener('mousedown', (e) => { if (e.target === layer) finish(false); });
    layer.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ask]');
      if (b) finish(b.dataset.ask === 'yes');
    });

    window.addEventListener('keydown', onKey, true);
    document.body.append(layer);

    // A question that destroys something opens on Cancel. Everything else opens
    // on the answer you almost certainly want.
    const first = layer.querySelector(destructive && !okOnly ? '[data-ask="no"]' : '[data-ask="yes"]');
    if (first) setTimeout(() => first.focus(), 0);
  });
}

/** A statement rather than a question: one button, and nothing to decide. */
export function tell(opts) {
  return ask({ confirmLabel: 'OK', ...opts, okOnly: true });
}
