// Themed modal dialogs - the save-changes prompt and a generic yes/no confirm.
// Pure DOM and Promises; no app state.

// Shared three-button modal (reuses the #save-dialog DOM): side-by-side buttons
// (row-reverse, primary on the right), Left/Right move focus, Enter activates the
// focused one, Escape / backdrop cancels (resolves index 2 - the last button is
// always the cancel-like option).
function showStackedDialog(opts: {
  title: string;
  leadTitle?: string;
  message?: string;
  labels: string[]; // 2-4 labels: primary first, cancel-like last
  centered?: boolean;
}): Promise<number> {
  return new Promise(resolve => {
    const dialog = document.getElementById('save-dialog')!;
    // Centered + multi-line title/message (newlines kept) for the warning variant.
    dialog.classList.toggle('dialog-centered', !!opts.centered);
    // A 4-button dialog gets a wider box so labels fit on one line (they still
    // wrap as a fallback if the box is too narrow on some platform).
    dialog.classList.toggle('dialog-wide', opts.labels.length === 4);
    const titleEl = document.getElementById('save-dialog-title')!;
    titleEl.replaceChildren();
    if (opts.leadTitle) {
      // A bigger lead line (e.g. "Warning!") above the heading.
      const lead = document.createElement('div');
      lead.className = 'dialog-lead';
      lead.textContent = opts.leadTitle;
      titleEl.append(lead, opts.title);
    } else {
      titleEl.textContent = opts.title;
    }
    const msg = document.getElementById('save-dialog-message')!;
    msg.textContent = opts.message ?? '';
    msg.style.display = opts.message ? '' : 'none';
    // DOM order: save (primary), discard, extra, cancel. The extra slot is only
    // used for a 4-button dialog; cancel is always last.
    const extra = document.getElementById('save-dialog-extra') as HTMLButtonElement;
    extra.hidden = opts.labels.length !== 4;
    const buttons = (opts.labels.length === 4
      ? ['save-dialog-save', 'save-dialog-discard', 'save-dialog-extra', 'save-dialog-cancel']
      : ['save-dialog-save', 'save-dialog-discard', 'save-dialog-cancel']
    ).map(id => document.getElementById(id) as HTMLButtonElement);
    buttons.forEach((b, i) => { b.textContent = opts.labels[i]; });
    dialog.removeAttribute('hidden');
    const last = buttons.length - 1;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
        // Buttons render row-reverse, so visually Right = lower index, Left = higher.
        const delta = e.key === 'ArrowRight' ? -1 : 1;
        buttons[Math.min(last, Math.max(0, (cur < 0 ? 0 : cur) + delta))].focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(last);
      }
    };

    const cleanup = (result: number) => {
      dialog.setAttribute('hidden', '');
      dialog.classList.remove('dialog-centered', 'dialog-wide');
      msg.style.display = '';
      extra.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    buttons.forEach((b, i) => { b.onclick = () => cleanup(i); });
    dialog.onclick = (e) => { if (e.target === dialog) cleanup(last); };
    document.addEventListener('keydown', onKey);
    buttons[0].focus();
  });
}

export function showSaveDialog(filename: string): Promise<'save' | 'discard' | 'cancel'> {
  return showStackedDialog({
    title: `Do you want to save the changes you made to "${filename}"?`,
    message: "Your changes will be lost if you don't save them.",
    labels: ['Save', "Don't Save", 'Cancel'],
  }).then(i => (['save', 'discard', 'cancel'] as const)[i]);
}

// Shared body text for the external-change dialogs (Save and close variants).
function externalChangeMessage(filename: string, reason: 'changed' | 'unknown'): string {
  return reason === 'changed'
    ? `"${filename}" was changed by another app after you opened it. `
      + 'Overwrite will replace the file on disk with your Marku version.\n\n'
      + 'Save As… will keep the changed file and save your Marku version as a new file.'
    : `Marku could not verify whether "${filename}" changed outside the app. `
      + 'Overwrite will replace the file on disk with your Marku version.\n\n'
      + 'Save As… will save your Marku version as a new file.';
}

// Conflict prompt on Save when the file on disk changed (or couldn't be verified)
// before an overwrite. No "reload" - the user keeps their version (Overwrite) or
// saves it alongside the changed file (Save As).
export function showExternalChange(
  filename: string,
  reason: 'changed' | 'unknown',
): Promise<'overwrite' | 'saveas' | 'cancel'> {
  return showStackedDialog({
    leadTitle: 'Warning!',
    title: 'File changed outside Marku',
    message: externalChangeMessage(filename, reason),
    labels: ['Overwrite', 'Save As…', 'Cancel'],
    centered: true,
  }).then(i => (['overwrite', 'saveas', 'cancel'] as const)[i]);
}

// Same conflict prompt when closing/quitting, with an extra Don't Save to close
// without saving (discard our edits, keep the changed file on disk).
export function showCloseConflict(
  filename: string,
  reason: 'changed' | 'unknown',
): Promise<'overwrite' | 'saveas' | 'discard' | 'cancel'> {
  return showStackedDialog({
    leadTitle: 'Warning!',
    title: 'File changed outside Marku',
    message: externalChangeMessage(filename, reason),
    labels: ['Overwrite', 'Save As…', "Don't Save", 'Cancel'],
    centered: true,
  }).then(i => (['overwrite', 'saveas', 'discard', 'cancel'] as const)[i]);
}

// Themed yes/no dialog (matches the save dialog). Resolves true on OK.
export function showConfirm(opts: { title: string; message: string; okLabel: string; cancelLabel: string }): Promise<boolean> {
  return new Promise(resolve => {
    const dialog = document.getElementById('confirm-dialog')!;
    document.getElementById('confirm-dialog-title')!.textContent = opts.title;
    document.getElementById('confirm-dialog-message')!.textContent = opts.message;
    const ok = document.getElementById('confirm-dialog-ok') as HTMLButtonElement;
    const cancel = document.getElementById('confirm-dialog-cancel') as HTMLButtonElement;
    ok.textContent = opts.okLabel;
    cancel.textContent = opts.cancelLabel;
    dialog.removeAttribute('hidden');

    // Buttons are laid out Cancel (left) / OK (right) via row-reverse, so map
    // the arrows to the visual sides. Enter activates the focused button
    // natively; Escape cancels.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); cancel.focus(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); ok.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    };

    const cleanup = (result: boolean) => {
      dialog.setAttribute('hidden', '');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
    dialog.onclick = (e) => { if (e.target === dialog) cleanup(false); };
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}
