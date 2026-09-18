import { invoke } from '@tauri-apps/api/core';
import type { Block } from './types';
import { app } from './state';
import { isTabDirty, renderTabBar, confirmClose, syncActiveTab, queueTabOp } from './tabs';

// Quit flow: Rust intercepts the exit (Cmd+Q) and emits 'quit-requested'. We
// prompt for every unsaved tab. Save/Don't Save closes that tab immediately;
// Cancel stops the quit, leaving still-open tabs open (already-closed ones stay
// closed). Once all unsaved tabs are handled, quit_app exits.
export async function handleQuitRequested() {
  // Guard against a second quit event (double Cmd+Q, repeated system event)
  // starting a parallel tab walk while a save dialog is already open.
  if (app.quitPromptActive) return;
  // A pop-up question (save / confirm / recent) must be answered first, so
  // ignore Cmd+Q while one is on screen.
  const dialogOpen = ['save-dialog', 'confirm-dialog', 'recent-modal'].some(id => {
    const el = document.getElementById(id);
    return !!el && !el.hasAttribute('hidden');
  });
  if (dialogOpen) return;
  app.quitPromptActive = true;
  try {
    // Run the whole walk through the tab-op queue so a stray Cmd+1 / Cmd+]
    // (or any tab switch) can't interleave with it and desync the editor.
    const shouldQuit = await queueTabOp(async () => {
      // Leave Source View and write the active editor content into the active
      // tab (same invariant as switch/new/open/close) - otherwise stale markdown
      // could misread dirty state or save one tab into another. getDocumentMarkdown
      // flushes the active textarea, so a separate commit() is not needed here.
      await syncActiveTab();

      // Prompt for each unsaved tab - active one first, then the rest in order.
      const order = [
        app.activeTabId,
        ...app.tabs.filter(t => t.id !== app.activeTabId).map(t => t.id),
      ];
      for (const id of order) {
        const tab = app.tabs.find(t => t.id === id);
        if (!tab || !isTabDirty(tab)) continue;
        app.activeTabId = tab.id;
        renderTabBar();
        const blocks = await invoke<Block[]>('parse_document', { content: tab.markdown });
        await app.editor.loadBlocks(blocks);
        // loadBlocks resets the editor's saved state; restore this tab's own so a
        // Cancel here keeps its Source View undo history.
        app.editor.importCmState(tab.cmState);
        const proceed = await confirmClose(tab);
        if (!proceed) return false; // cancelled - stop; already-closed tabs stay closed
        // User chose Save / Don't Save - close this tab now.
        const idx = app.tabs.findIndex(t => t.id === id);
        if (idx !== -1) app.tabs.splice(idx, 1);
      }
      return true;
    });
    if (shouldQuit) await invoke('quit_app');
  } finally {
    app.quitPromptActive = false;
  }
}
