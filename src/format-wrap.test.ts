import { describe, it, expect } from 'vitest';
import { decideWrapEdit, decideLinkEdit } from './format-wrap';
import type { PairedEdit } from './paired-symbols';

// Apply a PairedEdit so tests can assert on the resulting text and selection.
function apply(text: string, edit: PairedEdit): { text: string; anchor: number; head: number } {
  let out = text;
  for (const c of [...edit.changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return { text: out, anchor: edit.anchor, head: edit.head };
}

describe('decideWrapEdit - wrap a selection', () => {
  it('wraps with ** and keeps the selection on the inner text', () => {
    const edit = decideWrapEdit('abc', 0, 3, '**');
    expect(apply('abc', edit)).toEqual({ text: '**abc**', anchor: 2, head: 5 });
  });

  it('wraps with _ , ~~ and $$', () => {
    for (const m of ['_', '~~', '$$']) {
      const edit = decideWrapEdit('x', 0, 1, m);
      expect(apply('x', edit)).toEqual({ text: `${m}x${m}`, anchor: m.length, head: m.length + 1 });
    }
  });

  it('preserves a backward selection direction', () => {
    const edit = decideWrapEdit('abc', 3, 0, '**');
    expect(edit.anchor).toBe(5);
    expect(edit.head).toBe(2);
  });

  it('wraps only the selected part of a larger string', () => {
    // "abc" with only "b" selected (1..2) -> "a**b**c", selection still on "b"
    const edit = decideWrapEdit('abc', 1, 2, '**');
    expect(apply('abc', edit)).toEqual({ text: 'a**b**c', anchor: 3, head: 4 });
  });
});

describe('decideWrapEdit - toggle off', () => {
  it('unwraps when markers hug the selection from outside', () => {
    // "**abc**" with "abc" selected (2..5) -> "abc"
    const edit = decideWrapEdit('**abc**', 2, 5, '**');
    expect(apply('**abc**', edit)).toEqual({ text: 'abc', anchor: 0, head: 3 });
  });

  it('unwraps when the selection itself includes the markers', () => {
    // whole "**abc**" selected (0..7) -> "abc"
    const edit = decideWrapEdit('**abc**', 0, 7, '**');
    expect(apply('**abc**', edit)).toEqual({ text: 'abc', anchor: 0, head: 3 });
  });

  it('unwrap keeps a backward selection backward', () => {
    const edit = decideWrapEdit('**abc**', 5, 2, '**');
    expect(edit.anchor).toBe(3);
    expect(edit.head).toBe(0);
  });
});

describe('decideWrapEdit - empty caret', () => {
  it('inserts the pair and puts the caret between the markers', () => {
    const edit = decideWrapEdit('', 0, 0, '**');
    expect(apply('', edit)).toEqual({ text: '****', anchor: 2, head: 2 });
  });

  it('unwraps an empty pair when the caret sits inside it', () => {
    // "**|**" -> "|"
    const edit = decideWrapEdit('****', 2, 2, '**');
    expect(apply('****', edit)).toEqual({ text: '', anchor: 0, head: 0 });
  });
});

describe('decideLinkEdit', () => {
  it('wraps a selection as a link with the caret between the parens', () => {
    const edit = decideLinkEdit('text', 0, 4);
    expect(apply('text', edit)).toEqual({ text: '[text]()', anchor: 7, head: 7 });
  });

  it('inserts empty brackets on an empty caret', () => {
    const edit = decideLinkEdit('', 0, 0);
    expect(apply('', edit)).toEqual({ text: '[]()', anchor: 1, head: 1 });
  });
});
