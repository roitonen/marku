import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './settings';
import type { AppSettings } from './settings';
import { CM_THEME_LIST } from './cm-theme-list';
import { PRISM_THEME_LIST } from './prism-theme-list';
import { applyPreviewTheme } from './preview-theme';

const win = getCurrentWindow();
let initialSnapshot = '';

function getFormValues(): AppSettings {
  return {
    previewFontFamily: (document.getElementById('s-preview-font') as HTMLInputElement).value,
    previewFontSize: Number((document.getElementById('s-preview-size') as HTMLInputElement).value),
    previewLineHeight: Number((document.getElementById('s-preview-lh') as HTMLInputElement).value),
    codeFontFamily: (document.getElementById('s-code-font') as HTMLInputElement).value,
    codeFontSize: Number((document.getElementById('s-code-size') as HTMLInputElement).value),
    codeLineHeight: Number((document.getElementById('s-code-lh') as HTMLInputElement).value),
    codeTheme: (document.getElementById('s-code-theme') as HTMLSelectElement).value,
    mermaidTheme: (document.getElementById('s-mermaid-theme') as HTMLSelectElement).value,
    prismTheme: (document.getElementById('s-prism-theme') as HTMLSelectElement).value,
    fontSmoothing: (document.getElementById('s-font-smoothing') as HTMLSelectElement).value,
    contentMaxWidth: Number((document.getElementById('s-content-width') as HTMLInputElement).value),
    wordWrap: (document.getElementById('s-word-wrap') as HTMLInputElement).checked,
    escapeUnsafeHtml: (document.getElementById('s-escape-unsafe-html') as HTMLInputElement).checked,
    rememberWindow: (document.getElementById('s-remember-window') as HTMLInputElement).checked,
    recentStore: Number((document.getElementById('s-recent-store') as HTMLInputElement).value),
    recentShow: Number((document.getElementById('s-recent-show') as HTMLInputElement).value),
  };
}

function snapshot(): string {
  return JSON.stringify(getFormValues());
}

function fillForm(s: AppSettings) {
  (document.getElementById('s-preview-font') as HTMLInputElement).value = s.previewFontFamily;
  (document.getElementById('s-preview-size') as HTMLInputElement).value = String(s.previewFontSize);
  (document.getElementById('s-preview-lh') as HTMLInputElement).value = String(s.previewLineHeight);
  const themeSel = document.getElementById('s-code-theme') as HTMLSelectElement;
  const hasTheme = CM_THEME_LIST.some(t => t.id === s.codeTheme);
  themeSel.value = hasTheme ? s.codeTheme : DEFAULT_SETTINGS.codeTheme;
  (document.getElementById('s-mermaid-theme') as HTMLSelectElement).value = s.mermaidTheme;
  const prismSel = document.getElementById('s-prism-theme') as HTMLSelectElement;
  prismSel.value = PRISM_THEME_LIST.some(t => t.id === s.prismTheme) ? s.prismTheme : DEFAULT_SETTINGS.prismTheme;
  (document.getElementById('s-font-smoothing') as HTMLSelectElement).value = s.fontSmoothing;
  (document.getElementById('s-code-font') as HTMLInputElement).value = s.codeFontFamily;
  (document.getElementById('s-code-size') as HTMLInputElement).value = String(s.codeFontSize);
  (document.getElementById('s-code-lh') as HTMLInputElement).value = String(s.codeLineHeight);
  (document.getElementById('s-content-width') as HTMLInputElement).value = String(s.contentMaxWidth);
  (document.getElementById('s-width-val') as HTMLElement).textContent = String(s.contentMaxWidth);
  (document.getElementById('s-word-wrap') as HTMLInputElement).checked = s.wordWrap;
  (document.getElementById('s-escape-unsafe-html') as HTMLInputElement).checked = s.escapeUnsafeHtml;
  (document.getElementById('s-remember-window') as HTMLInputElement).checked = s.rememberWindow;
  (document.getElementById('s-recent-store') as HTMLInputElement).value = String(s.recentStore);
  (document.getElementById('s-recent-show') as HTMLInputElement).value = String(s.recentShow);
  updateRecentShowState(s.recentStore);
}

function updateRecentShowState(storeVal: number) {
  (document.getElementById('s-recent-show') as HTMLInputElement).disabled = storeVal === 0;
}

function updateSaveButton() {
  const btn = document.getElementById('btn-save') as HTMLButtonElement;
  btn.disabled = snapshot() === initialSnapshot;
}

window.addEventListener('DOMContentLoaded', async () => {
  const codeThemeSelect = document.getElementById('s-code-theme') as HTMLSelectElement;
  for (const { id, label } of CM_THEME_LIST) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    codeThemeSelect.appendChild(opt);
  }

  const prismThemeSelect = document.getElementById('s-prism-theme') as HTMLSelectElement;
  for (const { id, label } of PRISM_THEME_LIST) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    prismThemeSelect.appendChild(opt);
  }

  try {
    const settings = await loadSettings();
    fillForm(settings);
    initialSnapshot = snapshot();
    applyPreviewTheme(settings.codeTheme, false);
  } finally {
    document.documentElement.style.opacity = '1';
  }

  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll<HTMLElement>('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
    });
  });

  document.getElementById('settings-form')?.addEventListener('input', updateSaveButton);
  document.getElementById('settings-form')?.addEventListener('change', updateSaveButton);

  // Live-recolor the settings window when the theme select changes.
  codeThemeSelect.addEventListener('change', () => applyPreviewTheme(codeThemeSelect.value, false));

  document.getElementById('s-content-width')?.addEventListener('input', (e) => {
    (document.getElementById('s-width-val') as HTMLElement).textContent = (e.target as HTMLInputElement).value;
  });

  document.getElementById('s-recent-store')?.addEventListener('input', (e) => {
    updateRecentShowState(Number((e.target as HTMLInputElement).value));
  });

  document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = getFormValues();
    await saveSettings(s);
    await invoke('notify_settings_changed');
    initialSnapshot = snapshot();
    updateSaveButton();
  });

  document.getElementById('btn-close')?.addEventListener('click', () => win.close());

  document.getElementById('btn-reset')?.addEventListener('click', async () => {
    const yes = await ask('Reset all settings to defaults?', { title: 'Reset to Defaults', kind: 'warning' });
    if (!yes) return;
    await saveSettings(DEFAULT_SETTINGS);
    fillForm(DEFAULT_SETTINGS);
    initialSnapshot = snapshot();
    applyPreviewTheme(DEFAULT_SETTINGS.codeTheme, false);
    updateSaveButton();
    await invoke('notify_settings_changed');
    await invoke('reset_main_window');
  });

  document.getElementById('s-clear-recent')?.addEventListener('click', async () => {
    const yes = await ask('Clear the list of recent files?', { title: 'Clear Recent Files', kind: 'warning' });
    if (!yes) return;
    // The recent store is owned by the main window's recentChain queue. Settings
    // is a separate webview with its own module state, so clearing here would run
    // outside that queue and could clobber a concurrent addRecentFile. Signal the
    // main window to do the clear inside its queue instead.
    await emit('clear-recent');
  });
});
