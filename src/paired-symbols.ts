// Pure decision logic for paired-symbol input, shared by the block textarea and
// CodeMirror so both behave identically. It knows nothing about the DOM, the
// editor, or undo history: given the current text, the selection (anchor/head),
// and the action (a typed character or Backspace), it returns the edit to apply
// or null to let the default behaviour happen. Keeping it pure makes it the
// single source of truth for both editors and lets it be unit-tested directly.

export interface PairedEdit {
  // Changes in ORIGINAL-document coordinates (callers map/apply them).
  changes: Array<{ from: number; to: number; insert: string }>;
  // New selection after the edit. anchor/head preserve direction.
  anchor: number;
  head: number;
}

export type PairedAction =
  | { type: 'insert'; char: string }
  | { type: 'backspace' };

// Brackets that auto-pair on an empty caret, and their closers.
const PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

// Characters that wrap a non-empty selection: brackets plus the markdown
// delimiters. The markdown ones (`'`, `` ` ``, `$`, `*`, `~`, `_`) only act on a
// selection - on an empty caret they are typed as ordinary characters.
const WRAP: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  "'": "'",
  '"': '"',
  '`': '`',
  $: '$',
  '*': '*',
  '~': '~',
  _: '_',
};

export function decidePairedEdit(
  text: string,
  anchor: number,
  head: number,
  action: PairedAction,
): PairedEdit | null {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);

  if (action.type === 'backspace') {
    if (from !== to) return null; // deleting a selection - ordinary Backspace
    // Empty pair, caret between an opener and its matching closer, immediately
    // adjacent: delete both. Anything between (space, text) -> ordinary Backspace.
    const open = text[from - 1];
    if (open !== undefined && PAIR[open] !== undefined && text[from] === PAIR[open]) {
      return { changes: [{ from: from - 1, to: from + 1, insert: '' }], anchor: from - 1, head: from - 1 };
    }
    return null;
  }

  const ch = action.char;

  // Non-empty selection: wrap it, keeping the selection inside the markers (and
  // its direction). Only the wrapping characters apply.
  if (from !== to) {
    const close = WRAP[ch];
    if (close === undefined) return null;
    return {
      changes: [
        { from, to: from, insert: ch },
        { from: to, to, insert: close },
      ],
      anchor: anchor + 1,
      head: head + 1,
    };
  }

  // Empty caret. Type over an existing closer instead of inserting a duplicate.
  if (CLOSERS.has(ch) && text[from] === ch) {
    return { changes: [], anchor: from + 1, head: from + 1 };
  }
  // Auto-pair an opening bracket, caret between the two. Quotes and markdown
  // delimiters do not pair on an empty caret - fall through to ordinary typing.
  if (PAIR[ch] !== undefined) {
    return { changes: [{ from, to: from, insert: ch + PAIR[ch] }], anchor: from + 1, head: from + 1 };
  }
  return null;
}
