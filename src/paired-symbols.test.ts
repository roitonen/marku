import { describe, it, expect } from 'vitest';
import { decidePairedEdit, type PairedEdit } from './paired-symbols';

// Apply a PairedEdit to a string so tests can assert on the resulting text and
// caret the way an editor would (changes are in original-document coordinates,
// so apply them right-to-left to keep offsets valid).
function apply(text: string, edit: PairedEdit): { text: string; anchor: number; head: number } {
  let out = text;
  for (const c of [...edit.changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return { text: out, anchor: edit.anchor, head: edit.head };
}

const insert = (char: string) => ({ type: 'insert', char }) as const;
const backspace = { type: 'backspace' } as const;

describe('auto-pair brackets on empty caret', () => {
  it('pairs ( [ {', () => {
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      const edit = decidePairedEdit('', 0, 0, insert(open))!;
      expect(apply('', edit)).toEqual({ text: open + close, anchor: 1, head: 1 });
    }
  });

  it('does not pair quotes or markdown delimiters', () => {
    for (const ch of ["'", '`', '$', '*', '~', '_', '"']) {
      expect(decidePairedEdit('', 0, 0, insert(ch))).toBeNull();
    }
  });

  it('ordinary characters fall through', () => {
    expect(decidePairedEdit('', 0, 0, insert('a'))).toBeNull();
  });
});

describe('type-over closing brackets', () => {
  it('skips over an existing closer without inserting', () => {
    // "(|)" typing ")" -> "()" caret after
    const edit = decidePairedEdit('()', 1, 1, insert(')'))!;
    expect(edit.changes).toEqual([]);
    expect(apply('()', edit)).toEqual({ text: '()', anchor: 2, head: 2 });
  });

  it('inserts a closer normally when the next char is different', () => {
    expect(decidePairedEdit('(a', 2, 2, insert(')'))).toBeNull();
  });
});

describe('backspace inside an empty pair', () => {
  it('deletes both when caret sits between opener and matching closer', () => {
    const edit = decidePairedEdit('()', 1, 1, backspace)!;
    expect(apply('()', edit)).toEqual({ text: '', anchor: 0, head: 0 });
  });

  it('does NOT delete the pair when a space is between', () => {
    // "( |)" caret after the space
    expect(decidePairedEdit('( )', 2, 2, backspace)).toBeNull();
  });

  it('does NOT delete the pair when content is between', () => {
    // "(e|)" caret after e
    expect(decidePairedEdit('(e)', 2, 2, backspace)).toBeNull();
  });

  it('ignores non-matching neighbours', () => {
    expect(decidePairedEdit('(]', 1, 1, backspace)).toBeNull();
  });
});

describe('wrap a selection', () => {
  it('wraps with brackets and keeps the selection inside', () => {
    // "abc" all selected, type "(" -> "(abc)" selection still on abc
    const edit = decidePairedEdit('abc', 0, 3, insert('('))!;
    expect(apply('abc', edit)).toEqual({ text: '(abc)', anchor: 1, head: 4 });
  });

  it('wraps with markdown delimiters', () => {
    for (const ch of ["'", '"', '`', '$', '*', '~', '_']) {
      const edit = decidePairedEdit('x', 0, 1, insert(ch))!;
      expect(apply('x', edit)).toEqual({ text: `${ch}x${ch}`, anchor: 1, head: 2 });
    }
  });

  it('preserves a backward selection direction', () => {
    // selection from 3 back to 0 (anchor 3, head 0)
    const edit = decidePairedEdit('abc', 3, 0, insert('('))!;
    expect(edit.anchor).toBe(4);
    expect(edit.head).toBe(1);
  });

  it('does not wrap with a non-wrapping character', () => {
    expect(decidePairedEdit('abc', 0, 3, insert('a'))).toBeNull();
  });
});
