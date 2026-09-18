// The live CodeMirror "Source View" editor. Owns only the live CM view, its
// theme/colors, word wrap, find panel and live formatting/undo. It does NOT own
// the document history (cmSaved) or the preview blocks - the Editor stays the
// coordinator and talks to this class by value through open() / close().

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment, type Extension, Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, historyKeymap, history, isolateHistory, undo, redo } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, closeSearchPanel } from '@codemirror/search';
import { decidePairedEdit } from './paired-symbols';
import { decideWrapEdit, decideLinkEdit } from './format-wrap';

export type SourceCaret = { ln: number; col: number };

// Structural styles - always applied regardless of theme.
const markuStructure = EditorView.theme({
  '.cm-content': { fontFamily: 'var(--code-font-family)', fontSize: 'var(--code-font-size)', lineHeight: 'var(--code-line-height)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2em', textAlign: 'right' },
  '.cm-line': { padding: '0' },
  '.cm-gutters': { border: 'none', paddingLeft: '12px', paddingRight: '16px' },
});

export class SourceView {
  private cmView: EditorView | null = null;
  private wrapCompartment = new Compartment();
  private themeCompartment = new Compartment();
  private wordWrapEnabled = false;
  private currentTheme = 'default';
  private uiBg = '';
  private uiFg = '';

  constructor(
    private statusLn: HTMLElement,
    private statusCol: HTMLElement,
  ) {}

  isActive(): boolean {
    return this.cmView !== null;
  }

  getMarkdown(): string {
    return this.cmView?.state.doc.toString() ?? '';
  }

  // Build a fresh CodeMirror state for `doc`. The Editor computes whether to reuse
  // the saved state (history) or build fresh; this is the "build fresh" path.
  createState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        history(),
        // Tab inserts two spaces (before defaultKeymap so it wins over indent).
        keymap.of([{
          key: 'Tab',
          preventDefault: true,
          run: (view) => {
            view.dispatch(view.state.replaceSelection('  '));
            return true;
          },
        }]),
        // Paired symbols: same decidePairedEdit as the textarea, so both editors
        // behave identically. inputHandler covers typing (pairs / type-over /
        // wrap); the Backspace keymap (before defaultKeymap so it wins) covers
        // deleting an empty pair. Each is one CM transaction = one undo step.
        keymap.of([{
          key: 'Backspace',
          run: (view) => {
            const sel = view.state.selection.main;
            if (!sel.empty || view.composing) return false;
            const edit = decidePairedEdit(view.state.doc.toString(), sel.anchor, sel.head, { type: 'backspace' });
            if (!edit) return false;
            view.dispatch({
              changes: edit.changes,
              selection: { anchor: edit.anchor, head: edit.head },
              annotations: Transaction.userEvent.of('delete'),
            });
            return true;
          },
        }]),
        EditorView.inputHandler.of((view, _from, _to, insert) => {
          if (insert.length !== 1 || view.composing) return false; // skip IME
          const sel = view.state.selection.main;
          const edit = decidePairedEdit(view.state.doc.toString(), sel.anchor, sel.head, { type: 'insert', char: insert });
          if (!edit) return false;
          view.dispatch({
            changes: edit.changes,
            selection: { anchor: edit.anchor, head: edit.head },
            annotations: Transaction.userEvent.of('input.type'),
          });
          return true;
        }),
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        markuStructure,
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        // Find panel (Cmd+F) at the top; highlights other matches too.
        search({ top: true }),
        highlightSelectionMatches(),
        this.wrapCompartment.of([]),
        this.themeCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            this.statusLn.textContent = `Ln ${line.number}`;
            this.statusCol.textContent = `Col ${pos - line.from + 1}`;
          }
        }),
      ],
    });
  }

  // Show the source editor with the given state and place the caret.
  open(state: EditorState, caret: SourceCaret | null): void {
    const editorContainer = document.getElementById('editor-container')!;
    const sv = document.getElementById('source-view')!;
    const cmHost = document.getElementById('source-editor')!;

    // Make the source container visible before creating the editor so CodeMirror
    // measures the real viewport width (line wrapping depends on it).
    editorContainer.hidden = true;
    sv.hidden = false;

    this.cmView = new EditorView({ state, parent: cmHost });

    if (this.wordWrapEnabled) {
      this.cmView.dispatch({
        effects: this.wrapCompartment.reconfigure(EditorView.lineWrapping),
      });
    }
    this.setTheme(this.currentTheme);
    if (caret) {
      const lnum = Math.min(caret.ln, this.cmView.state.doc.lines);
      const lineObj = this.cmView.state.doc.line(lnum);
      const anchor = Math.min(lineObj.from + caret.col - 1, lineObj.to);
      this.cmView.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      });
    }
    this.cmView.focus();
    document.getElementById('status-mode')!.textContent = 'S';

    // Closing the find panel (× or Esc): CodeMirror would yank it from the DOM
    // instantly, so intercept - play the slide-out, then close on animation end.
    const animateCloseSearch = (): boolean => {
      const panel = this.cmView?.dom.querySelector('.cm-panels-top') as HTMLElement | null;
      if (!panel) return false; // no search panel open
      if (panel.classList.contains('cm-search-closing')) return true; // already closing
      panel.classList.add('cm-search-closing');

      // Close once, whichever fires first. animationend won't fire under
      // prefers-reduced-motion (or if the animation is missing), so a fallback
      // timer (a touch longer than the 0.18s slide-out) guarantees it closes.
      let closed = false;
      let timer = 0;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (this.cmView) closeSearchPanel(this.cmView);
      };
      panel.addEventListener('animationend', finish, { once: true });
      timer = window.setTimeout(finish, 250);
      return true;
    };
    this.cmView.dom.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.cm-search [name="close"]')) return;
      e.preventDefault();
      e.stopPropagation();
      animateCloseSearch();
    }, true);
    this.cmView.dom.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Only when the search panel is open; otherwise let Esc do its thing.
      if (!this.cmView?.dom.querySelector('.cm-panels-top')) return;
      e.preventDefault();
      e.stopPropagation();
      animateCloseSearch();
    }, true);
  }

  // Tear down the source editor and return its final state, markdown and caret
  // (caret null when at the very document start - the Editor leaves no block
  // active in that case).
  close(): { state: EditorState; markdown: string; caret: SourceCaret | null } {
    const view = this.cmView!;
    let caret: SourceCaret | null = null;
    const head = view.state.selection.main.head;
    if (head > 0) {
      const line = view.state.doc.lineAt(head);
      caret = { ln: line.number, col: head - line.from + 1 };
    }
    const state = view.state;
    const markdown = view.state.doc.toString();
    view.destroy();
    this.cmView = null;
    document.getElementById('source-view')!.hidden = true;
    document.getElementById('editor-container')!.hidden = false;
    this.uiBg = '';
    this.uiFg = '';
    document.getElementById('status-mode')!.textContent = 'P';
    return { state, markdown, caret };
  }

  setTheme(themeId: string): void {
    this.currentTheme = themeId;
    if (!this.cmView) return;
    const apply = (ext: Extension) => {
      this.cmView?.dispatch({ effects: this.themeCompartment.reconfigure(ext) });
      requestAnimationFrame(() => {
        if (!this.cmView) return;
        const style = getComputedStyle(this.cmView.dom);
        this.uiBg = style.backgroundColor;
        this.uiFg = style.color;
        const root = document.documentElement;
        root.style.setProperty('--ui-bg', this.uiBg);
        root.style.setProperty('--ui-fg', this.uiFg);
        this.applyGutterFade();
      });
    };
    import('./cm-themes').then(({ CM_THEMES }) => {
      apply(CM_THEMES[themeId] ?? []);
    });
  }

  // Fade the left/right edges of the line-number gutter into the editor
  // background - but only when the gutter has its own distinct background.
  private applyGutterFade(): void {
    const gutters = this.cmView?.dom.querySelector('.cm-gutters') as HTMLElement | null;
    if (!gutters) return;
    const gutterBg = getComputedStyle(gutters).backgroundColor;
    const transparent = gutterBg === 'rgba(0, 0, 0, 0)' || gutterBg === 'transparent';
    const distinct = !transparent && gutterBg !== this.uiBg;
    gutters.classList.toggle('gutter-fade', distinct);
  }

  setWordWrap(enabled: boolean): void {
    this.wordWrapEnabled = enabled;
    if (!this.cmView) return;
    this.cmView.dispatch({
      effects: this.wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []),
    });
  }

  // Re-apply the theme's UI colors (called after a tab redraw resets them).
  applyUIColors(): void {
    if (!this.cmView || !this.uiBg) return;
    const root = document.documentElement;
    root.style.setProperty('--ui-bg', this.uiBg);
    root.style.setProperty('--ui-fg', this.uiFg);
  }

  // Formatting on the live editor: one CM transaction = one undo step, tagged
  // input.type so the unified history treats it like typing. `marker` null = link.
  applyFormat(marker: string | null): void {
    if (!this.cmView) return;
    if (marker !== null) this.cmFormatWrap(this.cmView, marker);
    else this.cmFormatLink(this.cmView);
    this.cmView.focus();
  }

  private cmFormatWrap(view: EditorView, marker: string): void {
    const sel = view.state.selection.main;
    const edit = decideWrapEdit(view.state.doc.toString(), sel.anchor, sel.head, marker);
    view.dispatch({
      changes: edit.changes,
      selection: { anchor: edit.anchor, head: edit.head },
      annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')],
    });
  }

  private cmFormatLink(view: EditorView): void {
    const sel = view.state.selection.main;
    const edit = decideLinkEdit(view.state.doc.toString(), sel.anchor, sel.head);
    view.dispatch({
      changes: edit.changes,
      selection: { anchor: edit.anchor, head: edit.head },
      annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')],
    });
  }

  undo(): void {
    if (this.cmView) undo(this.cmView);
  }

  redo(): void {
    if (this.cmView) redo(this.cmView);
  }
}
