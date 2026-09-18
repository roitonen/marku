// Tab + document management: a tab is one open document (or an empty buffer),
// so opening/saving files lives here alongside tab switching and the tab bar.
import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import type { Block, FileContent, FileSignature } from './types';
import { addRecentFile } from './settings';
import { showSaveDialog, showConfirm, showExternalChange, showCloseConflict } from './dialogs';
import { app, type TabState } from './state';

// Document-switching ops (switch/new/open/close) are async and mutate both
// app.activeTabId and the editor's loaded blocks across several awaits. Running
// two at once interleaves them - e.g. a fast A->B->C switch can finish B's
// loadBlocks last, leaving the editor showing B while C is the active tab (so a
// later save writes B's text into C's file). Serialize them: each runs to
// completion before the next starts. Public wrappers enqueue; the *Impl bodies
// call each other directly so nested calls don't deadlock on the same queue.
let tabOpChain: Promise<unknown> = Promise.resolve();
export function queueTabOp<T>(op: () => Promise<T>): Promise<T> {
  const run = tabOpChain.then(op, op);
  tabOpChain = run.then(() => {}, () => {});
  return run;
}

export function makeTab(path: string | null = null, markdown = ''): TabState {
  return { id: app.nextTabId++, path, markdown, savedMarkdown: markdown, cmState: null };
}

// Split on both separators so Windows paths (C:\…\file.md) show the file name,
// not the whole path.
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(0, i) : '';
}

function tabTitle(tab: TabState): string {
  return tab.title ?? (tab.path ? fileName(tab.path) : 'Untitled.md');
}

function activeTab(): TabState {
  let tab = app.tabs.find(t => t.id === app.activeTabId);
  if (!tab) {
    tab = makeTab();
    app.tabs.push(tab);
    app.activeTabId = tab.id;
  }
  return tab;
}

export function isTabDirty(tab: TabState): boolean {
  const md = tab.id === app.activeTabId ? app.editor.getDocumentMarkdown() : tab.markdown;
  return md !== tab.savedMarkdown;
}

// Record the file's on-disk signature (mtime + size) on the tab, to detect later
// external changes. On any failure (gone, metadata error) clear it rather than
// keep a stale one - a missing signature reads as "unknown" before the next save,
// which is safer than a wrong "unchanged".
async function captureDiskSig(tab: TabState) {
  if (!tab.path) { tab.diskMtimeMs = undefined; tab.diskSize = undefined; return; }
  try {
    const sig = await invoke<FileSignature | null>('file_signature', { path: tab.path });
    tab.diskMtimeMs = sig?.mtimeMs;
    tab.diskSize = sig?.size;
  } catch (e) {
    tab.diskMtimeMs = undefined;
    tab.diskSize = undefined;
    console.warn('file_signature failed', e);
  }
}

// Did the file change on disk since we captured its signature?
//   'none'    - unchanged, or path-less, or deleted externally (we recreate it)
//   'changed' - signature differs
//   'unknown' - no captured signature, or we couldn't read metadata; NOT "safe"
async function checkExternalChange(tab: TabState): Promise<'none' | 'changed' | 'unknown'> {
  if (!tab.path) return 'none';
  if (tab.diskMtimeMs === undefined || tab.diskSize === undefined) return 'unknown';
  let sig: FileSignature | null;
  try {
    sig = await invoke<FileSignature | null>('file_signature', { path: tab.path });
  } catch (e) {
    console.warn('file_signature failed', e);
    return 'unknown';
  }
  if (sig === null) return 'none'; // deleted externally - the write recreates it
  return sig.mtimeMs === tab.diskMtimeMs && sig.size === tab.diskSize ? 'none' : 'changed';
}

// Suggested Save As name when overwriting would clobber external changes, so the
// dialog defaults to a different file and keeps both versions: temp.md -> temp-new.md.
function suggestConflictName(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-new${name.slice(dot)}` : `${name}-new`;
}

export function renderTabBar() {
  if (app.editor?.isSourceViewActive()) requestAnimationFrame(() => app.editor.applyUIColors());
  const list = document.getElementById('tabs-list')!;
  list.innerHTML = '';
  for (const tab of app.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === app.activeTabId ? ' active' : '');

    const name = document.createElement('span');
    name.textContent = tabTitle(tab);
    el.appendChild(name);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(close);

    el.addEventListener('click', () => switchToTab(tab.id));
    list.appendChild(el);
  }
  updateTitle();
}

// Before any tab/file change: leave Source View (which parses CodeMirror back
// into blocks) and store the current editor content into the active tab. Without
// this, a live Source View would keep returning its old document for the new tab,
// risking saving one tab's text into another.
export async function syncActiveTab() {
  await app.editor.exitSourceView();
  const current = app.tabs.find(t => t.id === app.activeTabId);
  if (current) {
    current.markdown = app.editor.getDocumentMarkdown();
    current.cmState = app.editor.exportCmState();
  }
}

async function switchToTabImpl(id: number) {
  if (id === app.activeTabId) return;
  // The tab may have been closed while this op waited in the queue; bail so we
  // don't set activeTabId to a dead id (activeTab() would spawn an empty tab).
  if (!app.tabs.some(t => t.id === id)) return;
  await syncActiveTab();
  app.activeTabId = id;
  renderTabBar();
  const tab = activeTab();
  if (tab.markdown) {
    const blocks = await invoke<Block[]>('parse_document', { content: tab.markdown });
    await app.editor.loadBlocks(blocks);
  } else {
    await app.editor.initEmpty();
  }
  // loadBlocks / initEmpty reset the editor's saved state; restore this tab's own.
  app.editor.importCmState(tab.cmState);
}

export function switchToTab(id: number): Promise<void> {
  return queueTabOp(() => switchToTabImpl(id));
}

// Cycle to the next (dir +1) or previous (dir -1) tab, wrapping around. The
// neighbour is computed inside the queued op so a fast double Cmd+] advances two
// tabs (computing it eagerly would pick the same neighbour for both presses).
export function switchToAdjacentTab(dir: 1 | -1): void {
  void queueTabOp(async () => {
    if (app.tabs.length < 2) return;
    const i = app.tabs.findIndex(t => t.id === app.activeTabId);
    if (i === -1) return;
    const next = app.tabs[(i + dir + app.tabs.length) % app.tabs.length];
    await switchToTabImpl(next.id);
  });
}

async function newTabImpl() {
  await syncActiveTab();
  const tab = makeTab();
  app.tabs.push(tab);
  app.activeTabId = tab.id;
  renderTabBar();
  await app.editor.initEmpty();
}

export function newTab(): Promise<void> {
  return queueTabOp(newTabImpl);
}

// The same file can be reached by different path strings (symlinks, case
// differences on macOS/Windows, trailing slashes, etc.), so compare canonical
// forms resolved in Rust rather than raw strings. Returns the tab that owns
// `path`, if any (optionally excluding one tab id).
async function tabForPath(path: string, excludeId?: number): Promise<TabState | undefined> {
  const target = await invoke<string>('canonical_path', { path });
  for (const t of app.tabs) {
    if (t.id === excludeId || !t.path) continue;
    if (await invoke<string>('canonical_path', { path: t.path }) === target) return t;
  }
  return undefined;
}

// Write a file via the atomic save command, surfacing any failure (permissions,
// disk full, gone directory) in a dialog instead of leaving an unhandled
// rejection. Returns true on success so callers only mark the tab saved when the
// bytes actually landed.
async function writeFile(path: string, content: string): Promise<boolean> {
  try {
    await invoke('save_file', { path, content });
    return true;
  } catch (e) {
    await message(`Could not save "${fileName(path)}".\n\n${e}`, { title: 'Save Failed', kind: 'error' });
    return false;
  }
}

// True when a read error means the file is gone (Rust tags it NOT_FOUND:), as
// opposed to a transient permission/read failure.
export function isNotFoundError(error: unknown): boolean {
  return String(error).startsWith('NOT_FOUND');
}

// Surface a failed open (read error, permissions, bad UTF-8) in a dialog instead
// of leaving an unhandled rejection or a console-only message. Strips the
// internal NOT_FOUND: tag before showing the message to the user.
export async function showOpenError(path: string | undefined, error: unknown): Promise<void> {
  const detail = String(error).replace(/^NOT_FOUND:\s*/, '');
  const what = path ? `"${fileName(path)}"` : 'the file';
  await message(`Could not open ${what}.\n\n${detail}`, { title: 'Open Failed', kind: 'error' });
}

// Save As to a freshly picked path. The path is checked against other open tabs
// first: writing onto a path another tab already owns would let both tabs claim
// the same file and overwrite each other. On a clash we offer to switch to that
// tab and write nothing. Returns the written path, or null if cancelled/declined.
async function saveAsToNewPath(content: string, selfId: number, defaultName?: string): Promise<string | null> {
  const path = await invoke<string | null>('pick_save_path', { defaultName });
  if (!path) return null;
  const clash = await tabForPath(path, selfId);
  if (clash) {
    const goThere = await showConfirm({
      title: 'File already open',
      message: `"${fileName(path)}" is already open in another tab. Saving here would let both tabs overwrite each other.`,
      okLabel: 'Switch to it',
      cancelLabel: 'Cancel',
    });
    if (goThere) await switchToTabImpl(clash.id);
    return null;
  }
  if (!await writeFile(path, content)) return null;
  return path;
}

export async function confirmClose(tab: TabState): Promise<boolean> {
  // Let a just-queued structural edit (e.g. Enter right before Cmd+W) finish, so
  // the dirty check below sees the real document and doesn't close silently.
  await app.editor.flushPendingOps();
  if (!isTabDirty(tab)) return true;
  const content = tab.id === app.activeTabId ? app.editor.getDocumentMarkdown() : tab.markdown;

  // If the file changed on disk, show the external-change dialog directly instead
  // of the plain "save changes" prompt, so the warning isn't hidden behind Save.
  if (tab.path) {
    const change = await checkExternalChange(tab);
    if (change !== 'none') {
      const choice = await showCloseConflict(tabTitle(tab), change);
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true; // close without saving, keep the changed file
      if (choice === 'saveas') return await doSaveAs(tab, content, suggestConflictName(tab.path));
      // 'overwrite' - write our version over the changed file, then close.
      if (!await writeFile(tab.path, content)) return false;
      tab.markdown = content;
      tab.savedMarkdown = content;
      await captureDiskSig(tab);
      return true;
    }
  }

  const result = await showSaveDialog(tabTitle(tab));
  if (result === 'cancel') return false;
  if (result === 'save') {
    if (!tab.path) {
      // Save As (path-less): close only if the user actually picks a file.
      if (!await doSaveAs(tab, content, tab.title)) return false;
    } else {
      // Save failed (and was reported) - don't close, the edits are still unsaved.
      if (!await writeFile(tab.path, content)) return false;
      tab.markdown = content;
      tab.savedMarkdown = content;
      await captureDiskSig(tab);
    }
  }
  return true;
}

// Tabs currently being closed, so a second close (double click on ×, repeated
// Cmd+W while the save dialog is open) doesn't run a parallel confirmClose and
// splice the wrong tab.
const closingTabIds = new Set<number>();

async function closeTabImpl(id: number) {
  if (closingTabIds.has(id)) return;
  const tab = app.tabs.find(t => t.id === id);
  if (!tab) return;
  closingTabIds.add(id);
  try {
    const prevActiveTabId = app.activeTabId;
    const proceed = await confirmClose(tab);
    if (!proceed) return; // Cancel - leave state untouched (Source View stays open)
    // Only now leave Source View / sync, before loading another tab.
    await syncActiveTab();

    // The tab could have gone away while the dialog was open.
    const idx = app.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;

    if (app.tabs.length === 1) {
      app.tabs[0] = makeTab();
      app.activeTabId = app.tabs[0].id;
      renderTabBar();
      await app.editor.initEmpty();
      return;
    }

    app.tabs.splice(idx, 1);
    if (prevActiveTabId === id) {
      const next = app.tabs[Math.min(idx, app.tabs.length - 1)];
      app.activeTabId = next.id;
      renderTabBar();
      const blocks = await invoke<Block[]>('parse_document', { content: next.markdown });
      await app.editor.loadBlocks(blocks);
      app.editor.importCmState(next.cmState);
    } else {
      app.activeTabId = prevActiveTabId;
      renderTabBar();
    }
  } finally {
    closingTabIds.delete(id);
  }
}

export function closeTab(id: number): Promise<void> {
  return queueTabOp(() => closeTabImpl(id));
}

export async function openFile() {
  let result: FileContent | null;
  try {
    result = await invoke<FileContent | null>('open_file');
  } catch (e) {
    await showOpenError(undefined, e);
    return;
  }
  if (!result) return;
  await openFilePath(result.path, result.content);
}

async function openFilePathImpl(path: string, content: string) {
  // Already open in a tab? Just switch to it instead of opening a duplicate.
  // (Keeps that tab's content, including any unsaved edits.) Compare canonical
  // paths so symlinks / case differences don't sneak in a duplicate.
  const existing = await tabForPath(path);
  if (existing) {
    await switchToTabImpl(existing.id);
    return;
  }
  await syncActiveTab();
  const current = activeTab();
  const isEmpty = !current.path && current.markdown.trim() === '';

  if (isEmpty) {
    current.path = path;
    current.markdown = content;
    current.savedMarkdown = content;
  } else {
    const tab = makeTab(path, content);
    app.tabs.push(tab);
    app.activeTabId = tab.id;
  }

  const blocks = await invoke<Block[]>('parse_document', { content });
  await app.editor.loadBlocks(blocks);
  await captureDiskSig(activeTab());
  renderTabBar();
  addRecentFile(path).catch(console.error);
}

export function openFilePath(path: string, content: string): Promise<void> {
  return queueTabOp(() => openFilePathImpl(path, content));
}

// Open a bundled Help document (path-less, named, fully rendered by the editor).
async function openHelpDocImpl(fileTitle: string, content: string) {
  // Already open? Just switch - never overwrite, the user may have edited it.
  const existing = app.tabs.find(t => t.title === fileTitle);
  if (existing) {
    await switchToTabImpl(existing.id);
    return;
  }
  await syncActiveTab();
  // Always a new tab: Help is a reference next to the document, so don't replace
  // the current empty buffer the way opening a file does.
  const tab = makeTab(null, content);
  tab.title = fileTitle;
  app.tabs.push(tab);
  app.activeTabId = tab.id;
  const blocks = await invoke<Block[]>('parse_document', { content });
  await app.editor.loadBlocks(blocks);
  renderTabBar();
}

export function openHelpDoc(fileTitle: string, content: string): Promise<void> {
  return queueTabOp(() => openHelpDocImpl(fileTitle, content));
}

// Save As with full bookkeeping; returns true once bytes land. Shared by Save As
// and by the "Save As…" choice in the external-change conflict dialog. A saved
// Help doc becomes an ordinary file, so the synthetic title is dropped.
async function doSaveAs(tab: TabState, content: string, defaultName?: string): Promise<boolean> {
  const path = await saveAsToNewPath(content, tab.id, defaultName);
  if (!path) return false;
  tab.path = path;
  tab.title = undefined;
  tab.markdown = content;
  tab.savedMarkdown = content;
  await captureDiskSig(tab);
  renderTabBar();
  void addRecentFile(path);
  return true;
}

async function saveFileImpl() {
  const tab = activeTab();
  if (!tab.path) { await saveFileAsImpl(); return; }
  await app.editor.commit();
  const content = app.editor.getDocumentMarkdown();
  // Guard against overwriting changes another app made since we opened/saved.
  const change = await checkExternalChange(tab);
  if (change !== 'none') {
    const choice = await showExternalChange(tabTitle(tab), change);
    if (choice === 'cancel') return;
    if (choice === 'saveas') { await doSaveAs(tab, content, suggestConflictName(tab.path)); return; }
    // 'overwrite' falls through to the normal write below.
  }
  if (!await writeFile(tab.path, content)) return;
  tab.markdown = content;
  tab.savedMarkdown = content;
  await captureDiskSig(tab);
}

export function saveFile(): Promise<void> {
  return queueTabOp(saveFileImpl);
}

async function saveFileAsImpl() {
  const tab = activeTab();
  await app.editor.commit();
  const content = app.editor.getDocumentMarkdown();
  await doSaveAs(tab, content, tab.title);
}

export function saveFileAs(): Promise<void> {
  return queueTabOp(saveFileAsImpl);
}

function updateTitle() {
  const tab = activeTab();
  const name = tab?.title ?? (tab?.path ? fileName(tab.path) : 'Untitled');
  document.title = `${name} - Marku`;
}
