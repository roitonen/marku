import { Extension } from '@codemirror/state';
import { githubLight, githubDark } from '@uiw/codemirror-theme-github';
import { materialLight, materialDark } from '@uiw/codemirror-theme-material';
import { nord } from '@uiw/codemirror-theme-nord';
import { dracula } from '@uiw/codemirror-theme-dracula';
import { xcodeLight, xcodeDark } from '@uiw/codemirror-theme-xcode';
import { monokai } from '@uiw/codemirror-theme-monokai';
import { solarizedLight, solarizedDark } from '@uiw/codemirror-theme-solarized';
import { bbedit } from '@uiw/codemirror-theme-bbedit';
import { aura } from '@uiw/codemirror-theme-aura';
import { sublime } from '@uiw/codemirror-theme-sublime';
import { duotoneLight, duotoneDark } from '@uiw/codemirror-theme-duotone';
import { tokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { andromeda } from '@uiw/codemirror-theme-andromeda';
import { atomone } from '@uiw/codemirror-theme-atomone';
import { okaidia } from '@uiw/codemirror-theme-okaidia';
import { copilot } from '@uiw/codemirror-theme-copilot';
import { eclipse } from '@uiw/codemirror-theme-eclipse';
import { basicLight, basicDark } from '@uiw/codemirror-theme-basic';
import { whiteLight, whiteDark } from '@uiw/codemirror-theme-white';
import { catppuccinLatte, catppuccinFrappe, catppuccinMacchiato, catppuccinMocha } from '@catppuccin/codemirror';

export const CM_THEMES: Record<string, Extension> = {
  'github-light':    githubLight,
  'github-dark':     githubDark,
  'material-light':  materialLight,
  'material-dark':   materialDark,
  'nord':            nord,
  'dracula':         dracula,
  'xcode-light':     xcodeLight,
  'xcode-dark':      xcodeDark,
  'monokai':         monokai,
  'solarized-light': solarizedLight,
  'solarized-dark':  solarizedDark,
  'bbedit':          bbedit,
  'aura':            aura,
  'sublime':         sublime,
  'duotone-light':   duotoneLight,
  'duotone-dark':    duotoneDark,
  'tokyo-night':     tokyoNight,
  'andromeda':       andromeda,
  'atomone':         atomone,
  'okaidia':         okaidia,
  'copilot':         copilot,
  'eclipse':         eclipse,
  'basic-light':     basicLight,
  'basic-dark':      basicDark,
  'white-light':     whiteLight,
  'white-dark':      whiteDark,
  'catppuccin-latte':     catppuccinLatte,
  'catppuccin-frappe':    catppuccinFrappe,
  'catppuccin-macchiato': catppuccinMacchiato,
  'catppuccin-mocha':     catppuccinMocha,
};
