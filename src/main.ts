import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Menu } from '@tauri-apps/api/menu';
import { PredefinedMenuItem } from '@tauri-apps/api/menu/predefinedMenuItem';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Editor } from './editor';
import { loadSettings, applySettings, saveSettings, DEFAULT_SETTINGS, clearRecentFiles } from './settings';
import { applyPreviewTheme } from './preview-theme';
import { applyPrismTheme } from './prism-theme';
import { app } from './state';
import {
  makeTab, newTab, openFile, openFilePath, saveFile, saveFileAs,
  closeTab, renderTabBar, switchToTab, switchToAdjacentTab, showOpenError, openHelpDoc,
} from './tabs';
import { showRecentFiles } from './recent-modal';
import { handleQuitRequested } from './quit-flow';
import gettingStartedMd from './help/getting-started.md?raw';
import shortcutsMd from './help/shortcuts.md?raw';
import markdownMd from './help/markdown.md?raw';
import troubleshootingMd from './help/troubleshooting.md?raw';

// Help menu items -> bundled Markdown opened as a named tab. The file-style
// title doubles as the Save As default name.
const HELP_DOCS: Record<string, { title: string; md: string }> = {
  'getting-started': { title: 'getting-started.md', md: gettingStartedMd },
  'shortcuts':       { title: 'shortcuts.md',       md: shortcutsMd },
  'markdown':        { title: 'markdown-guide.md',  md: markdownMd },
  'troubleshooting': { title: 'troubleshooting.md', md: troubleshootingMd },
};

window.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('document')!;
  const statusLn = document.getElementById('status-ln')!;
  const statusCol = document.getElementById('status-col')!;
  const statusStats = document.getElementById('status-stats')!;

  try {
    app.settings = await loadSettings();
    applySettings(app.settings);
    applyPreviewTheme(app.settings.codeTheme);
    applyPrismTheme(app.settings.prismTheme);
  } finally {
    // Always reveal the window: HTML starts at opacity 0, so a failure above
    // must not leave it invisible forever.
    document.documentElement.style.opacity = '1';
  }


  app.editor = new Editor(container, statusLn, statusCol, statusStats);
  app.editor.onExitSourceView = () => applyPreviewTheme(app.settings.codeTheme);
  app.editor.setWordWrap(app.settings.wordWrap);
  // Sync the native menu checkmark to the loaded value: on first launch or a
  // missing/corrupt settings.json the frontend falls back to its own default,
  // so the menu must be told explicitly rather than trusting its build-time read.
  void invoke('set_word_wrap_menu', { checked: app.settings.wordWrap });
  // Push the HTML-escaping setting to the Rust renderer (defaults to on there).
  void invoke('set_escape_unsafe_html', { enabled: app.settings.escapeUnsafeHtml });
  app.editor.setCodeTheme(app.settings.codeTheme);
  void app.editor.setMermaidTheme(app.settings.mermaidTheme);

  const first = makeTab();
  app.tabs.push(first);
  app.activeTabId = first.id;
  renderTabBar();
  await app.editor.initEmpty();

  document.getElementById('new-tab-btn')!.addEventListener('click', () => newTab());

  // Right-click → our own native menu with exactly Cut/Copy/Paste. preventDefault
  // suppresses WKWebView's built-in menu (which would also expose Inspect Element
  // etc. in dev). Predefined items route the clipboard action to the focused
  // textarea / CodeMirror. Built once and reused.
  let contextMenu: Menu | null = null;
  document.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (!contextMenu) {
      const [cut, copy, paste] = await Promise.all([
        PredefinedMenuItem.new({ item: 'Cut' }),
        PredefinedMenuItem.new({ item: 'Copy' }),
        PredefinedMenuItem.new({ item: 'Paste' }),
      ]);
      contextMenu = await Menu.new({ items: [cut, copy, paste] });
    }
    await contextMenu.popup();
  });

  await listen('menu:new', () => newTab());
  await listen('menu:open', () => openFile());
  await listen('menu:save', () => saveFile());
  await listen('menu:save-as', () => saveFileAs());
  await listen('menu:print', () => app.editor.print());
  await listen('menu:render', () => app.editor.renderPreview());
  await listen('menu:undo', () => app.editor.undoActive());
  await listen('menu:redo', () => app.editor.redoActive());
  await listen<'bold' | 'italic' | 'strike' | 'math' | 'link'>('menu:format', (e) =>
    app.editor.applyFormat(e.payload),
  );
  await listen<string>('menu:help', (e) => {
    const doc = HELP_DOCS[e.payload];
    if (doc) void openHelpDoc(doc.title, doc.md);
  });
  await listen('menu:open-recent', () => showRecentFiles());
  // The Settings window asks us to clear recent files (it can't touch the store
  // directly - see settings-window.ts) so the clear runs inside our recentChain.
  await listen('clear-recent', () => clearRecentFiles());

  // Drag & drop: open dropped .md/.markdown files (others ignored). Tauri gives
  // real OS paths in payload.paths - not URL-encoded - so read straight through.
  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== 'drop') return;
    const paths = event.payload.paths.filter((p) => /\.(md|markdown)$/i.test(p));
    for (const path of paths) {
      try {
        const content = await invoke<string>('read_file', { path });
        await openFilePath(path, content);
      } catch (e) {
        await showOpenError(path, e);
      }
    }
  });
  await listen('settings-changed', async () => {
    const prevEscape = app.settings.escapeUnsafeHtml;
    app.settings = await loadSettings();
    applySettings(app.settings);
    applyPreviewTheme(app.settings.codeTheme);
    applyPrismTheme(app.settings.prismTheme);
    app.editor.setWordWrap(app.settings.wordWrap);
    app.editor.setCodeTheme(app.settings.codeTheme);
    void app.editor.setMermaidTheme(app.settings.mermaidTheme);
    void invoke('set_word_wrap_menu', { checked: app.settings.wordWrap });
    // HTML escaping changed: update the renderer, then repaint so it takes
    // effect (in Source View the exit re-renders from Markdown anyway).
    if (app.settings.escapeUnsafeHtml !== prevEscape) {
      await invoke('set_escape_unsafe_html', { enabled: app.settings.escapeUnsafeHtml });
      if (!app.editor.isSourceViewActive()) await app.editor.rerenderHtml();
    }
  });

  async function adjustFontSize(delta: number | null) {
    const inSource = app.editor.isSourceViewActive();
    if (inSource) {
      app.settings.codeFontSize = delta === null
        ? DEFAULT_SETTINGS.codeFontSize
        : Math.max(8, Math.min(48, app.settings.codeFontSize + delta));
    } else {
      app.settings.previewFontSize = delta === null
        ? DEFAULT_SETTINGS.previewFontSize
        : Math.max(8, Math.min(48, app.settings.previewFontSize + delta));
    }
    applySettings(app.settings);
    await saveSettings(app.settings);
  }

  async function toggleWordWrap() {
    app.settings.wordWrap = !app.settings.wordWrap;
    applySettings(app.settings);
    app.editor.setWordWrap(app.settings.wordWrap);
    void invoke('set_word_wrap_menu', { checked: app.settings.wordWrap });
    await saveSettings(app.settings);
  }

  await listen('menu:font-inc', () => adjustFontSize(1));
  await listen('menu:font-dec', () => adjustFontSize(-1));
  await listen('menu:font-reset', () => adjustFontSize(null));
  await listen('menu:word-wrap', () => toggleWordWrap());

  await listen('quit-requested', handleQuitRequested);


  function openSettingsWindow() {
    invoke('open_settings').catch(console.error);
  }

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      // Undo/redo in preview routes through the editor's unified history (in
      // Source View, CodeMirror's own keymap handles it - leave the event alone).
      if (e.key.toLowerCase() === 'z' && !app.editor.isSourceViewActive()) {
        e.preventDefault();
        if (e.shiftKey) void app.editor.redo();
        else void app.editor.undo();
      }
      if (e.key === 'e') { e.preventDefault(); app.editor.toggleSourceView(); }
      if (e.key === 'w') { e.preventDefault(); closeTab(app.activeTabId); }
      if (e.key === ',') { e.preventDefault(); openSettingsWindow(); }
      // Shift+Cmd+T toggles the tab bar (zeroing --tabbar-h moves the find panel up).
      if (e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        document.documentElement.classList.toggle('tabbar-hidden');
      }
      // Shift+Cmd+H is a second accelerator for Marku Help (the menu shows F1).
      if (e.shiftKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        const doc = HELP_DOCS['getting-started'];
        void openHelpDoc(doc.title, doc.md);
      }
      // Cmd+1…9 → switch to that tab by position (ignored if it doesn't exist).
      if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const tab = app.tabs[Number(e.key) - 1];
        if (tab) switchToTab(tab.id);
      }
      // Cmd+[ / Cmd+] → previous / next tab (event bubbles up from CodeMirror
      // too, so this also works in Source View).
      if (!e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        switchToAdjacentTab(e.key === ']' ? 1 : -1);
      }
    }
  });
});
