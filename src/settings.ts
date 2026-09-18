import { load, Store } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { CM_THEME_LIST } from './cm-theme-list';
import { PRISM_THEME_LIST } from './prism-theme-list';

export interface AppSettings {
  previewFontFamily: string;
  previewFontSize: number;
  previewLineHeight: number;
  fontSmoothing: string;     // -webkit-font-smoothing (macOS only)
  contentMaxWidth: number;
  codeFontFamily: string;
  codeFontSize: number;
  codeLineHeight: number;
  codeTheme: string;         // CodeMirror theme for the Source View editor
  mermaidTheme: string;
  prismTheme: string;        // Prism syntax theme for preview code blocks
  wordWrap: boolean;
  escapeUnsafeHtml: boolean; // escape raw <style>/<script>/... to text when rendering
  rememberWindow: boolean;
  recentStore: number;
  recentShow: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  previewFontFamily: 'system-ui',
  previewFontSize: 16,
  previewLineHeight: 1.7,
  fontSmoothing: 'auto',
  contentMaxWidth: 720,
  codeFontFamily: 'ui-monospace',
  codeFontSize: 14,
  codeLineHeight: 1.5,
  codeTheme: 'github-light',
  mermaidTheme: 'default',
  prismTheme: 'default',
  wordWrap: true,
  escapeUnsafeHtml: true,
  rememberWindow: true,
  recentStore: 15,
  recentShow: 5,
};

// Mermaid's built-in named themes offered in settings (excluding 'base', which
// renders unstyled without themeVariables).
export const MERMAID_THEMES = ['default', 'neutral', 'dark', 'forest'] as const;

// -webkit-font-smoothing values (macOS only; ignored on Windows/Linux).
export const FONT_SMOOTHING_VALUES = ['auto', 'antialiased', 'subpixel-antialiased'] as const;

let settingsStore: Store | null = null;
let recentStore: Store | null = null;

function isJsonObject(s: string): boolean {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

async function getSettingsStore(): Promise<Store | null> {
  if (settingsStore) return settingsStore;
  try {
    // tauri-plugin-store silently ignores a corrupt JSON file (loads an empty
    // store) and leaves the bad file on disk - which also desyncs Rust readers
    // like the Word Wrap menu item. So `load()` won't throw on corruption; we
    // validate the raw file ourselves first. If it exists but isn't a JSON
    // object, overwrite it with the full DEFAULT_SETTINGS (not `{}`, so Rust sees
    // the same defaults). A missing file is fine - first run. The store keeps
    // files in AppData, so target that dir.
    const path = await join(await appDataDir(), 'settings.json');
    let raw: string | null = null;
    try { raw = await invoke<string>('read_file', { path }); } catch { raw = null; }
    if (raw !== null && !isJsonObject(raw)) {
      // Corrupt file. Rust already opened this store during setup, so a plain
      // load() would hand back that cached empty store; createNew forces a fresh
      // store seeded with the defaults, and save() rewrites the file - keeping
      // store and disk consistent (and Rust readers on the same defaults).
      settingsStore = await load('settings.json', {
        defaults: { ...DEFAULT_SETTINGS },
        autoSave: false,
        createNew: true,
      });
      await settingsStore.save();
    } else {
      settingsStore = await load('settings.json', { defaults: {}, autoSave: false });
    }
  } catch {
    settingsStore = null; // unrecoverable - run on defaults rather than abort init
  }
  return settingsStore;
}

async function getRecentStore(): Promise<Store | null> {
  if (recentStore) return recentStore;
  try {
    recentStore = await load('recent.json', { defaults: {}, autoSave: false });
  } catch {
    // recent.json is unreadable/corrupt - overwrite it with an empty valid
    // store and reopen; if even that fails, behave as an empty list.
    try {
      const path = await join(await appDataDir(), 'recent.json');
      await invoke('save_file', { path, content: '{"files":[]}' });
      recentStore = await load('recent.json', { defaults: {}, autoSave: false });
    } catch {
      recentStore = null;
    }
  }
  return recentStore;
}

// Valid ranges for numeric settings - a corrupted store could otherwise pass
// finite-but-absurd values (e.g. fontSize -100, width 999999).
const RANGES: Partial<Record<keyof AppSettings, [number, number]>> = {
  previewFontSize: [8, 48],
  previewLineHeight: [1, 3],
  codeFontSize: [8, 48],
  codeLineHeight: [1, 3],
  contentMaxWidth: [720, 1600],
  recentStore: [0, 50],
  recentShow: [0, 15],
};

export async function loadSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();
  if (!store) return { ...DEFAULT_SETTINGS }; // store unrecoverable - run on defaults
  const settings = { ...DEFAULT_SETTINGS };
  let corrected = false; // a stored value was invalid and got fixed
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const val = await store.get<AppSettings[typeof key]>(key);
    const def = DEFAULT_SETTINGS[key];
    if (val === null || val === undefined) continue; // missing key is not an error
    // Guard against a corrupted store: wrong type or NaN/Infinity → keep default.
    if (typeof val !== typeof def) { corrected = true; continue; }
    if (typeof def === 'number' && !Number.isFinite(val)) { corrected = true; continue; }
    // Unknown theme → keep default.
    if (key === 'codeTheme' && typeof val === 'string'
        && !CM_THEME_LIST.some(t => t.id === val)) { corrected = true; continue; }
    // Unknown Mermaid theme → keep default.
    if (key === 'mermaidTheme' && typeof val === 'string'
        && !MERMAID_THEMES.includes(val as typeof MERMAID_THEMES[number])) { corrected = true; continue; }
    // Unknown Prism theme → keep default.
    if (key === 'prismTheme' && typeof val === 'string'
        && !PRISM_THEME_LIST.some(t => t.id === val)) { corrected = true; continue; }
    // Unknown font-smoothing value → keep default.
    if (key === 'fontSmoothing' && typeof val === 'string'
        && !FONT_SMOOTHING_VALUES.includes(val as typeof FONT_SMOOTHING_VALUES[number])) { corrected = true; continue; }
    let v: unknown = val;
    const range = RANGES[key];
    if (typeof v === 'number' && range) {
      const clamped = Math.max(range[0], Math.min(range[1], v));
      if (clamped !== v) corrected = true;
      v = clamped;
    }
    (settings as Record<string, unknown>)[key] = v;
  }
  // If we had to fix anything, heal the store file so it stops being corrupt.
  if (corrected) await saveSettings(settings);
  return settings;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getSettingsStore();
  if (!store) return; // store unrecoverable - can't persist, but don't crash
  for (const [key, val] of Object.entries(settings)) {
    await store.set(key, val);
  }
  await store.save();
}

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty('--preview-font-family', settings.previewFontFamily);
  root.style.setProperty('--preview-font-size', `${settings.previewFontSize}px`);
  root.style.setProperty('--preview-line-height', String(settings.previewLineHeight));
  root.style.setProperty('--code-font-family', settings.codeFontFamily);
  root.style.setProperty('--code-font-size', `${settings.codeFontSize}px`);
  root.style.setProperty('--code-line-height', String(settings.codeLineHeight));
  root.style.setProperty('--content-max-width', `${settings.contentMaxWidth}px`);
  root.style.setProperty('--font-smoothing', settings.fontSmoothing);
  document.body.classList.toggle('word-wrap', settings.wordWrap);
}

// Recent files
//
// Every recent-store change is a read-modify-write (get 'files' → mutate →
// set → save). Callers fire these without awaiting (e.g. addRecentFile on a
// multi-file drag-drop), so two could interleave and clobber each other -
// dropping entries or scrambling order. Funnel them all through one queue so
// each completes before the next reads.
let recentChain: Promise<unknown> = Promise.resolve();
function queueRecentOp<T>(op: () => Promise<T>): Promise<T> {
  const run = recentChain.then(op, op);
  recentChain = run.then(() => {}, () => {});
  return run;
}

// Read `files` and coerce anything that isn't an array of strings to an empty
// list. Every read (load and the mutations) goes through this, so a corrupt or
// hand-edited store (e.g. {"files": 123}) can never reach .filter()/.unshift().
async function readRecentList(store: Store): Promise<string[]> {
  const files = await store.get<unknown>('files');
  if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) return [];
  return files as string[];
}

export function loadRecentFiles(): Promise<string[]> {
  return queueRecentOp(async () => {
    const store = await getRecentStore();
    if (!store) return [];
    const files = await store.get<unknown>('files');
    // Corrupted store (not an array of strings) → reset it to an empty list.
    if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) {
      await store.set('files', []);
      await store.save();
      return [];
    }
    return files as string[];
  });
}

export function clearRecentFiles(): Promise<void> {
  return queueRecentOp(async () => {
    const store = await getRecentStore();
    if (!store) return;
    await store.set('files', []);
    await store.save();
  });
}

export function removeRecentFile(path: string): Promise<void> {
  return queueRecentOp(async () => {
    const store = await getRecentStore();
    if (!store) return;
    let files = await readRecentList(store);
    files = files.filter(f => f !== path);
    await store.set('files', files);
    await store.save();
  });
}

export function addRecentFile(path: string): Promise<void> {
  return queueRecentOp(async () => {
    const store = await getRecentStore();
    if (!store) return;
    const settings = await loadSettings();
    if (settings.recentStore === 0) return;

    let files = await readRecentList(store);
    files = files.filter(f => f !== path);
    files.unshift(path);
    if (files.length > settings.recentStore) files = files.slice(0, settings.recentStore);
    await store.set('files', files);
    await store.save();
  });
}
