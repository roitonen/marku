import type { EditorState } from '@codemirror/state';
import type { Editor } from './editor';
import type { AppSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';

export interface TabState {
  id: number;
  path: string | null;
  markdown: string;
  savedMarkdown: string;
  // Persisted Source View (CodeMirror) state with its undo history, so each tab
  // keeps its own history across tab switches. In memory only - never saved to disk.
  cmState: EditorState | null;
  // Display name for a path-less tab (Help docs, e.g. "shortcuts.md"). Shown in
  // the tab bar and window title, and used as the Save As default name. Cleared
  // once the tab is saved to a real path, so it becomes an ordinary file.
  title?: string;
  // Disk signature (mtime + size) captured when the file was opened/saved, used
  // to detect external changes before overwriting. Undefined = not captured /
  // not verified (treated as "unknown" before a save).
  diskMtimeMs?: number;
  diskSize?: number;
}

// Shared mutable app state on a single object so the split-out modules can both
// read and mutate it - an imported `let` can't be reassigned across modules,
// but an object's fields can. `editor` is assigned once during startup.
export const app = {
  editor: null as unknown as Editor,
  tabs: [] as TabState[],
  activeTabId: 0,
  nextTabId: 0,
  settings: { ...DEFAULT_SETTINGS } as AppSettings,
  quitPromptActive: false,
  recentModalCleanup: null as (() => void) | null,
};
