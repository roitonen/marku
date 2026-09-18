// Pure decision logic for formatting hotkeys (Cmd+B/I, strikethrough, display
// math, link), shared by the block textarea and CodeMirror so both behave
// identically. Like paired-symbols.ts it knows nothing about the DOM: given the
// current text, the selection (anchor/head) and a marker, it returns the edit to
// apply. Symmetric markers toggle - wrapping an unwrapped selection, unwrapping
// one that is already wrapped.

import type { PairedEdit } from './paired-symbols';

// Keep the resulting selection on the same side it started (forward vs backward).
function withDir(anchor: number, head: number, from: number, to: number): { anchor: number; head: number } {
  return anchor <= head ? { anchor: from, head: to } : { anchor: to, head: from };
}

// Wrap or unwrap a selection with a symmetric marker (e.g. "**", "_", "~~",
// "$$"). On an empty caret it inserts the pair and places the caret between
// them, unless the caret already sits inside an empty pair, which unwraps it.
export function decideWrapEdit(
  text: string,
  anchor: number,
  head: number,
  marker: string,
): PairedEdit {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  const m = marker.length;

  const outsideBefore = text.slice(from - m, from) === marker;
  const outsideAfter = text.slice(to, to + m) === marker;

  if (from === to) {
    // Empty caret. Sitting inside an existing empty pair "**|**" -> unwrap.
    if (outsideBefore && outsideAfter) {
      return {
        changes: [
          { from: from - m, to: from, insert: '' },
          { from: to, to: to + m, insert: '' },
        ],
        anchor: from - m,
        head: from - m,
      };
    }
    // Otherwise insert the pair and drop the caret between the markers.
    return {
      changes: [{ from, to: from, insert: marker + marker }],
      anchor: from + m,
      head: from + m,
    };
  }

  // Non-empty selection. Toggle off when markers hug the selection from outside.
  if (outsideBefore && outsideAfter) {
    return {
      changes: [
        { from: from - m, to: from, insert: '' },
        { from: to, to: to + m, insert: '' },
      ],
      ...withDir(anchor, head, from - m, to - m),
    };
  }

  // ...or when the selection itself includes the markers at both edges.
  if (
    to - from >= 2 * m &&
    text.slice(from, from + m) === marker &&
    text.slice(to - m, to) === marker
  ) {
    return {
      changes: [
        { from, to: from + m, insert: '' },
        { from: to - m, to, insert: '' },
      ],
      ...withDir(anchor, head, from, to - 2 * m),
    };
  }

  // Not wrapped yet: wrap it, keeping the selection on the inner text.
  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    ...withDir(anchor, head, from + m, to + m),
  };
}

// Cmd+K: turn the selection into a link "[selection]()" with the caret between
// the parens, ready to type the url. On an empty caret insert "[]()" with the
// caret in the brackets, ready for the link text.
export function decideLinkEdit(_text: string, anchor: number, head: number): PairedEdit {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);

  if (from === to) {
    return {
      changes: [{ from, to: from, insert: '[]()' }],
      anchor: from + 1,
      head: from + 1,
    };
  }

  // Caret lands between the parens: after "[" + selection + "](".
  const urlCaret = to + 3;
  return {
    changes: [
      { from, to: from, insert: '[' },
      { from: to, to, insert: ']()' },
    ],
    anchor: urlCaret,
    head: urlCaret,
  };
}
