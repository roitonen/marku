import { defaultSettingsGithubLight, defaultSettingsGithubDark } from '@uiw/codemirror-theme-github';
import { defaultSettingsMaterialLight, defaultSettingsMaterialDark } from '@uiw/codemirror-theme-material';
import { defaultSettingsNord } from '@uiw/codemirror-theme-nord';
import { defaultSettingsDracula } from '@uiw/codemirror-theme-dracula';
import { defaultSettingsXcodeLight, defaultSettingsXcodeDark } from '@uiw/codemirror-theme-xcode';
import { defaultSettingsMonokai } from '@uiw/codemirror-theme-monokai';
import { defaultSettingsBbedit } from '@uiw/codemirror-theme-bbedit';
import { defaultSettingsAura } from '@uiw/codemirror-theme-aura';
import { defaultSettingsSublime } from '@uiw/codemirror-theme-sublime';
import { defaultSettingsDuotoneLight, defaultSettingsDuotoneDark } from '@uiw/codemirror-theme-duotone';
import { defaultSettingsTokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { defaultSettingsAndromeda } from '@uiw/codemirror-theme-andromeda';
import { defaultSettingsAtomone } from '@uiw/codemirror-theme-atomone';
import { defaultSettingsOkaidia } from '@uiw/codemirror-theme-okaidia';
import { defaultSettingsCopilot } from '@uiw/codemirror-theme-copilot';
import { defaultSettingsEclipse } from '@uiw/codemirror-theme-eclipse';
import { defaultSettingsSolarizedLight, defaultSettingsSolarizedDark } from '@uiw/codemirror-theme-solarized';
import { defaultSettingsBasicLight, defaultSettingsBasicDark } from '@uiw/codemirror-theme-basic';
import { defaultSettingsWhiteLight, defaultSettingsWhiteDark } from '@uiw/codemirror-theme-white';

interface ThemeColors {
  background?: string;
  foreground?: string;
  caret?: string;
  gutterBackground?: string;
  gutterForeground?: string;
  lineHighlight?: string;
  selection?: string;
}

const PREVIEW_SETTINGS: Record<string, ThemeColors> = {
  'github-light':    defaultSettingsGithubLight,
  'github-dark':     defaultSettingsGithubDark,
  'material-light':  defaultSettingsMaterialLight,
  'material-dark':   defaultSettingsMaterialDark,
  'nord':            defaultSettingsNord,
  'dracula':         defaultSettingsDracula,
  'xcode-light':     defaultSettingsXcodeLight,
  'xcode-dark':      defaultSettingsXcodeDark,
  'monokai':         defaultSettingsMonokai,
  'bbedit':          defaultSettingsBbedit,
  'aura':            defaultSettingsAura,
  'sublime':         defaultSettingsSublime,
  'duotone-light':   defaultSettingsDuotoneLight,
  'duotone-dark':    defaultSettingsDuotoneDark,
  'tokyo-night':     defaultSettingsTokyoNight,
  'andromeda':       defaultSettingsAndromeda,
  'atomone':         defaultSettingsAtomone,
  'okaidia':         defaultSettingsOkaidia,
  'copilot':         defaultSettingsCopilot,
  'eclipse':         defaultSettingsEclipse,
  'solarized-light': defaultSettingsSolarizedLight,
  'solarized-dark':  defaultSettingsSolarizedDark,
  'basic-light':     defaultSettingsBasicLight,
  'basic-dark':      defaultSettingsBasicDark,
  'white-light':     defaultSettingsWhiteLight,
  'white-dark':      defaultSettingsWhiteDark,
  // Catppuccin palette - the package ships no defaultSettings, so map by hand.
  'catppuccin-latte':     { background: '#eff1f5', foreground: '#4c4f69', caret: '#8839ef', gutterBackground: '#ccd0da', gutterForeground: '#8c8fa1' },
  'catppuccin-frappe':    { background: '#303446', foreground: '#c6d0f4', caret: '#ca9ee6', gutterBackground: '#414559', gutterForeground: '#838ba7' },
  'catppuccin-macchiato': { background: '#24273a', foreground: '#cad3f5', caret: '#c6a0f6', gutterBackground: '#363a4f', gutterForeground: '#8087a2' },
  'catppuccin-mocha':     { background: '#1e1e2e', foreground: '#cdd6f4', caret: '#cba6f7', gutterBackground: '#313244', gutterForeground: '#7f849c' },
};

function mix(color: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${amount}%, transparent)`;
}

// Perceived brightness (0-255) of a #rgb/#rrggbb color, or null if unparseable.
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Use the color as-is unless it's too close to the background, then fall back.
function visibleOn(color: string, bg: string, fallback: string): string {
  const lc = luminance(color);
  const lb = luminance(bg);
  if (lc !== null && lb !== null && Math.abs(lc - lb) < 50) return fallback;
  return color;
}

// Link colors taken from each theme's own t.link style (the caret is the
// cursor color and unreliable for links). Themes without an explicit link
// color fall back to the foreground.
const LINK_COLORS: Record<string, string> = {
  'aura':            '#61ffca',
  'basic-light':     '#6987AF',
  'basic-dark':      '#6987AF',
  'duotone-light':   '#063289',
  'duotone-dark':    '#063289',
  'eclipse':         '#221199',
  'github-light':    '#005cc5',
  'github-dark':     '#79c0ff',
  'material-light':  '#56c8d8',
  'material-dark':   '#56c8d8',
  'nord':            '#a3be8c',
  'tokyo-night':     '#b4f9f8',
  'xcode-light':     '#0e0eff',
  'xcode-dark':      '#0e0eff',
  // Themes without a t.link color - use variableName (a bright accent).
  'dracula':         '#50fa7b',
  'monokai':         '#FD971F',
  'okaidia':         '#9effff',
  'solarized-light': '#268BD2',
  'solarized-dark':  '#268BD2',
  'andromeda':       '#00e8c6',
  'copilot':         '#939da5',
  'sublime':         '#5AB0B0',
  'atomone':         'hsl(207, 82%, 66%)',
  'catppuccin-latte':     '#1e66f5',
  'catppuccin-frappe':    '#8caaee',
  'catppuccin-macchiato': '#8aadf4',
  'catppuccin-mocha':     '#89b4fa',
};

// All CSS variables this module manages (used for reset).
const VAR_KEYS = [
  '--preview-bg', '--preview-fg', '--preview-heading', '--preview-muted',
  '--preview-code-bg', '--preview-link', '--preview-link-decoration',
  '--preview-checkbox', '--preview-selection', '--preview-caret',
  '--preview-active-line',
  '--preview-border', '--preview-blockquote-border', '--preview-table-alt',
  '--ui-bg', '--ui-fg',
];

// Single source of truth: derive the full set of preview CSS variables for a
// theme. Returns null when the theme has no known color settings.
export function computeThemeColors(themeId: string): Record<string, string> | null {
  const colors = PREVIEW_SETTINGS[themeId];
  if (!colors) return null;

  const bg = colors.background ?? '#ffffff';
  const fg = colors.foreground ?? '#000000';
  const caret = colors.caret ?? fg;
  const gutterBg = colors.gutterBackground ?? bg;
  const muted = colors.gutterForeground ?? mix(fg, 50);

  // Link: theme's own link color, otherwise the text color.
  const link = LINK_COLORS[themeId] ?? fg;
  // Themes mark links with textDecoration: underline, so always underline.
  const linkDecoration = 'underline';
  // Checkbox accent: link if it differs from text, else caret if it differs,
  // else fall back to the system default.
  const checkbox = link !== fg ? link : (caret !== fg ? caret : 'auto');
  // Text selection: theme's selection color, else a translucent link tint.
  const selection = colors.selection ?? mix(link, 30);
  // Caret: theme's caret color, but fall back to text when it blends into bg.
  const caretColor = visibleOn(caret, bg, fg);
  // Active line: the theme's own lineHighlight (often already semi-transparent).
  const activeLine = colors.lineHighlight ?? mix(fg, 4);

  return {
    '--preview-bg': bg,
    '--preview-fg': fg,
    '--preview-heading': fg,
    '--preview-muted': muted,
    '--preview-code-bg': gutterBg,
    '--preview-link': link,
    '--preview-link-decoration': linkDecoration,
    '--preview-checkbox': checkbox,
    '--preview-selection': selection,
    '--preview-caret': caretColor,
    '--preview-active-line': activeLine,
    '--preview-border': mix(fg, 20),
    '--preview-blockquote-border': mix(fg, 30),
    '--preview-table-alt': mix(fg, 5),
    '--ui-bg': bg,
    '--ui-fg': fg,
  };
}

// persistCache: write the startup cache only for the real applied theme
// (startup / after Save). Live-preview in Settings passes false so an
// unsaved, just-previewed theme never leaks into the next launch.
export function applyPreviewTheme(themeId: string, persistCache = true) {
  const root = document.documentElement;
  const vars = computeThemeColors(themeId);

  if (!vars) {
    VAR_KEYS.forEach(v => root.style.removeProperty(v));
    document.body.style.background = '';
    document.body.style.color = '';
    return;
  }

  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  document.body.style.background = vars['--ui-bg'];
  document.body.style.color = vars['--ui-fg'];

  // Mark dark themes (by background luminance) so theme-aware bits like the
  // GitHub-style alerts can pick a light/dark palette.
  // luminance() is on a 0..255 scale, so the dark threshold is ~128 (not 0.5).
  const lum = luminance(vars['--ui-bg']);
  root.classList.toggle('theme-dark', lum !== null && lum < 128);

  if (persistCache) {
    localStorage.setItem('marku-theme-cache', JSON.stringify({
      ...vars, body_bg: vars['--ui-bg'], body_color: vars['--ui-fg'],
    }));
  }
}
