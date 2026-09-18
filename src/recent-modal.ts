import { invoke } from '@tauri-apps/api/core';
import { loadRecentFiles, removeRecentFile } from './settings';
import { showConfirm } from './dialogs';
import { app } from './state';
import { fileName, dirName, openFilePath, isNotFoundError, showOpenError } from './tabs';

export async function showRecentFiles() {
  // If already open, tear down the previous keydown listener before re-opening.
  app.recentModalCleanup?.();
  const files = await loadRecentFiles();
  const show = app.settings.recentShow ?? 5;
  const list = files.slice(0, show);

  const modal = document.getElementById('recent-modal')!;
  const ul = document.getElementById('recent-list')!;
  ul.innerHTML = '';

  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'recent-empty';
    li.textContent = 'No recent files';
    ul.appendChild(li);
  } else {
    for (const path of list) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      // Hovering moves keyboard focus here, so mouse and arrow-key navigation
      // share one highlight (no stale hover highlight under a hidden cursor).
      li.addEventListener('mouseenter', () => li.focus());
      const name = fileName(path);
      const dir = dirName(path);
      const info = document.createElement('div');
      info.className = 'recent-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'recent-name';
      nameEl.textContent = name;
      const dirEl = document.createElement('span');
      dirEl.className = 'recent-dir';
      dirEl.textContent = dir;
      info.appendChild(nameEl);
      info.appendChild(dirEl);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'recent-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeRecentFile(path);
        li.remove();
        if (ul.children.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'recent-empty';
          empty.textContent = 'No recent files';
          ul.appendChild(empty);
        }
      });
      li.appendChild(info);
      li.appendChild(removeBtn);
      li.addEventListener('click', async () => {
        try {
          const content = await invoke<string>('read_file', { path });
          close();
          await openFilePath(path, content);
        } catch (e) {
          close();
          if (isNotFoundError(e)) {
            // File is gone (moved/deleted). Offer to drop the stale entry, then
            // return to the recents list either way.
            const remove = await showConfirm({
              title: `Remove "${name}" from Recent Files?`,
              message: "The file couldn't be opened - it may have been moved or deleted.",
              okLabel: 'Remove',
              cancelLabel: 'Cancel',
            });
            if (remove) await removeRecentFile(path);
          } else {
            // Transient failure (permissions, read error, bad UTF-8): report it,
            // but keep the entry - the file may open fine next time.
            await showOpenError(path, e);
          }
          await showRecentFiles();
        }
      });
      ul.appendChild(li);
    }
  }

  const close = () => {
    modal.setAttribute('hidden', '');
    document.removeEventListener('keydown', onKeyDown);
    app.recentModalCleanup = null;
  };
  modal.removeAttribute('hidden');
  modal.onclick = (e) => { if (e.target === modal) close(); };
  // X button uses the same close() so the keydown listener is removed too.
  const closeBtn = document.getElementById('recent-modal-close');
  if (closeBtn) closeBtn.onclick = close;

  const items = () => Array.from(ul.querySelectorAll<HTMLLIElement>('li[tabindex]'));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); return; }
    const els = items();
    if (els.length === 0) return;
    const cur = els.indexOf(document.activeElement as HTMLLIElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      els[Math.min(cur + 1, els.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      els[Math.max(cur - 1, 0)]?.focus();
    } else if (e.key === 'Enter' && cur >= 0) {
      e.preventDefault();
      els[cur].click();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  app.recentModalCleanup = close;

  // Focus the top (most recent) file so arrows/Enter work immediately.
  items()[0]?.focus();
}
