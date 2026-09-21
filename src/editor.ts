import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import katex from 'katex';
import mermaid from 'mermaid';
import type { Block, BlockKind } from './types';
import { decidePairedEdit, type PairedEdit } from './paired-symbols';
import { decideWrapEdit, decideLinkEdit } from './format-wrap';
import Prism from 'prismjs';
import { EditorState, Transaction, type StateCommand, type Annotation } from '@codemirror/state';
import { isolateHistory, undo, redo } from '@codemirror/commands';
import { SourceView } from './source-view';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-swift';

export class Editor {
  private blocks: Block[] = [];
  private blockIndex: Map<number, number> = new Map();
  private activeBlockId: number | null = null;
  private container: HTMLElement;
  private statusLn: HTMLElement;
  private statusCol: HTMLElement;
  private statusStats: HTMLElement;
  private nextLocalId = Date.now();
  private isDeactivating = false;
  // Persisted CodeMirror state for the current document, kept across Source View
  // toggles so the undo history survives switching to preview and back. Reset
  // whenever a different document is loaded (loadBlocks / initEmpty). This is the
  // document's unified undo history - preview edits mirror into it via syncToDoc.
  private cmSaved: EditorState | null = null;
  private readonly sourceView: SourceView;
  onExitSourceView: (() => void) | null = null;
  // Directory of the open .md file (null for an unsaved / path-less tab); local
  // image paths are resolved against it.
  getBaseDir: (() => string | null) | null = null;

  applyUIColors() {
    this.sourceView.applyUIColors();
  }

  isSourceViewActive(): boolean {
    return this.sourceView.isActive();
  }

  setCodeTheme(themeId: string) {
    this.sourceView.setTheme(themeId);
  }

  setWordWrap(enabled: boolean) {
    this.sourceView.setWordWrap(enabled);
  }

  constructor(
    container: HTMLElement,
    statusLn: HTMLElement,
    statusCol: HTMLElement,
    statusStats: HTMLElement,
  ) {
    this.container = container;
    this.statusLn = statusLn;
    this.statusCol = statusCol;
    this.statusStats = statusStats;
    this.sourceView = new SourceView(statusLn, statusCol);
    this.container.addEventListener('click', this.handleContainerClick.bind(this));
    document.addEventListener('mousedown', this.handleDocumentMouseDown.bind(this));
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
  }

  // Deactivate the active block only when the user presses the mouse outside
  // it. This keeps selection (incl. trackpad) and right-click context menus
  // from closing the block, which a focus/blur approach couldn't do reliably.
  private async handleDocumentMouseDown(e: MouseEvent) {
    if (this.activeBlockId === null || this.sourceView.isActive()) return;
    const activeEl = this.blockEl(this.activeBlockId);
    if (activeEl && !activeEl.contains(e.target as Node)) {
      await this.deactivate();
    }
  }

  // Source view

  // Source View transitions run on the same queue as structural edits and
  // undo/redo (opChain, defined below), so two fast Cmd+E presses can't desync
  // the editor AND Enter -> Cmd+E / Enter -> tab switch can't cross an in-flight
  // structural op.
  private enqueueSourceView(op: () => Promise<void>): Promise<void> {
    return this.enqueueOp(op);
  }

  // Serialize async structural edits (split/merge/paste) and undo/redo on one
  // queue, so a fast Enter -> Cmd+Z can't run undo while the split is still in
  // flight and have the split overwrite the undone blocks.
  private opChain: Promise<unknown> = Promise.resolve();
  private enqueueOp(op: () => Promise<void>): Promise<void> {
    const run = this.opChain.then(op, op);
    this.opChain = run.then(() => {}, () => {});
    return run;
  }

  // Resolve once all queued structural edits / undo-redo have finished. Callers
  // that read dirty state or save must await this first, or a just-queued edit
  // (Enter then Cmd+W / Cmd+S) could be missed and the tab close/save silently.
  flushPendingOps(): Promise<unknown> {
    return this.opChain;
  }

  // Run a structural mutation on the op queue, then mirror its result into the
  // history as one isolated step (so it doesn't merge with surrounding typing).
  private runStructural(fn: () => Promise<void>): Promise<void> {
    // beforeinput does not fire for a prevented Enter/Tab/paste, so capture the
    // pre-op caret here (synchronously) to record the correct undo position.
    const caret = this.caretDocRange();
    return this.enqueueOp(async () => {
      this.markCaret(caret);
      await fn();
      this.syncToDoc(undefined, true);
    });
  }

  async exitSourceView(): Promise<void> {
    return this.enqueueSourceView(async () => {
      if (this.sourceView.isActive()) await this.toggleSourceViewImpl();
    });
  }

  // Print / export to PDF: leave Source View and flush the active block so the
  // document shows fully-rendered HTML (not a textarea), then open the OS print
  // dialog (macOS: "Save as PDF"). @media print rules drop the editor chrome.
  async print() {
    await this.exitSourceView();
    await this.deactivate();
    await new Promise(requestAnimationFrame); // let the re-rendered block paint
    window.print();
  }

  // Render the document to preview: leave Source View (same as Cmd+E does in
  // code mode) and flush the active block so everything shows rendered HTML.
  async renderPreview() {
    await this.exitSourceView();
    await this.deactivate();
  }

  async toggleSourceView(): Promise<void> {
    return this.enqueueSourceView(() => this.toggleSourceViewImpl());
  }

  private async toggleSourceViewImpl() {
    if (!this.sourceView.isActive()) {
      // Enter Source View.
      // Snapshot the caret while the block is still active - deactivate() drops it.
      let entryCaret: { ln: number; col: number } | null = null;
      if (this.activeBlockId !== null) {
        const aIdx = this.blockIndex.get(this.activeBlockId);
        const aTa = this.blockEl(this.activeBlockId)?.querySelector('textarea');
        if (aIdx !== undefined && aTa) entryCaret = this.blockCaret(aIdx, aTa);
      }
      await this.deactivate();
      const md = this.getDocumentMarkdown();
      // Recovery: remove the preview DOM so a typed `<style>body{opacity:0}</style>`
      // stops affecting the document (hiding the container is not enough - style
      // elements in a hidden subtree still apply). The preview is rebuilt on exit.
      this.container.replaceChildren();
      this.sourceView.open(this.cmStateForEntry(md), entryCaret);
    } else {
      // Leave Source View. Keep the CM state (with its full undo history) as the
      // document history; applyParsedBlocks rebuilds the preview without resetting
      // cmSaved. Caret at the very document start -> leave no block active.
      const { state, markdown: newMd, caret: exitCaret } = this.sourceView.close();
      this.onExitSourceView?.();
      const blocks = await invoke<Block[]>('parse_document', { content: newMd });
      this.cmSaved = state;
      if (blocks.length > 0) {
        this.applyParsedBlocks(blocks);
      } else {
        // Empty document: initEmpty rebuilds cmSaved fresh, so restore the history.
        await this.initEmpty();
        this.cmSaved = state;
      }
      // Land the caret on the same line/col, in whichever block now holds it,
      // and center that block in the viewport (after autoResize set its height).
      if (exitCaret) {
        const target = this.globalToBlock(exitCaret.ln, exitCaret.col);
        if (target) {
          await this.activate(target.id, target.offset);
          requestAnimationFrame(() => {
            this.blockEl(target.id)?.scrollIntoView({ block: 'center' });
          });
        }
      }
    }
  }

  // Pick the CodeMirror state to open Source View with. No saved state -> build
  // fresh. Saved state matches the current document -> reuse it, so the undo
  // history is intact. Document changed in preview since we last left Source View
  // -> fold the whole preview session into the saved history as one isolated undo
  // step (isolateHistory), so it can be undone in one go without losing the
  // earlier Source View history.
  private cmStateForEntry(md: string): EditorState {
    const saved = this.cmSaved;
    if (saved === null) return this.sourceView.createState(md);
    if (saved.doc.toString() === md) return saved;
    const change = this.diffChange(saved.doc.toString(), md);
    return saved.update({ changes: change, annotations: isolateHistory.of('full') }).state;
  }

  // Minimal single-range diff between two strings: the change that turns `a`
  // into `b`, found by trimming the common prefix and suffix. Used to fold a
  // preview editing session into the saved CodeMirror history as one transaction.
  private diffChange(a: string, b: string): { from: number; to: number; insert: string } {
    let start = 0;
    const max = Math.min(a.length, b.length);
    while (start < max && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    return { from: start, to: endA, insert: b.slice(start, endB) };
  }

  // Hand the current document's saved CodeMirror state (with undo history) to
  // the tab layer when leaving the tab, and restore it when the tab comes back.
  // This is what makes each tab keep its own Source View history.
  exportCmState(): EditorState | null {
    return this.cmSaved;
  }

  // Restore a tab's saved state when it has one; otherwise keep the live state
  // loadBlocks just built (so cmSaved is never null while editing - the mirror
  // and undo depend on it).
  importCmState(state: EditorState | null): void {
    if (state !== null) this.cmSaved = state;
  }

  // Stage 2: the persistent CodeMirror state holds the document's undo history
  // even while editing in preview. After any edit, fold the change into it as a
  // transaction so history builds up live. Diffing the whole document means we
  // never have to instrument each edit path precisely - a missed call is caught
  // by the next sync (it only coarsens undo granularity, never corrupts).
  private syncToDoc(userEvent?: string, isolate = false): void {
    if (this.cmSaved === null || this.sourceView.isActive()) return;
    const md = this.getDocumentMarkdown();
    const old = this.cmSaved.doc.toString();
    if (old === md) return;
    // Record the caret too, so undo/redo restore where the edit happened.
    // userEvent lets CodeMirror group keystrokes/deletes/paste into sane steps;
    // isolate forces a structural edit (Enter, split, merge, paste) to be its
    // own undo step instead of merging with the typing around it.
    const sel = this.caretDocRange();
    const annotations: Annotation<unknown>[] = [];
    if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
    if (isolate) annotations.push(isolateHistory.of('full'));
    this.cmSaved = this.cmSaved.update({
      changes: this.diffChange(old, md),
      selection: sel !== null
        ? { anchor: Math.min(sel.anchor, md.length), head: Math.min(sel.head, md.length) }
        : undefined,
      annotations,
    }).state;
  }

  // Document selection (anchor + head) of the active textarea, for recording
  // selection in mirror transactions. base = chars of all blocks before the
  // active one (each joined by one '\n'), plus the local offsets. Direction is
  // preserved so undo restores the selection the way the user had it. Null when
  // no block is active.
  private caretDocRange(): { anchor: number; head: number } | null {
    if (this.activeBlockId === null) return null;
    const idx = this.blockIndex.get(this.activeBlockId);
    const ta = this.blockEl(this.activeBlockId)?.querySelector('textarea') as HTMLTextAreaElement | null;
    if (idx === undefined || !ta) return null;
    let base = 0;
    for (let i = 0; i < idx; i++) base += this.blocks[i].markdown.length + 1;
    const start = base + ta.selectionStart;
    const end = base + ta.selectionEnd;
    return ta.selectionDirection === 'backward'
      ? { anchor: end, head: start }
      : { anchor: start, head: end };
  }

  // Record the caret/selection into the history state WITHOUT creating an undo
  // step (addToHistory: false). This makes the next change record the correct
  // pre-edit selection for undo (so undo restores the selection, not just a
  // caret), while keeping adjacent edits coalescing into one step (a recorded
  // selection transaction would split typing per character).
  private markCaret(range: { anchor: number; head: number } | null): void {
    if (this.cmSaved === null || this.sourceView.isActive() || range === null) return;
    const len = this.cmSaved.doc.length;
    this.cmSaved = this.cmSaved.update({
      selection: { anchor: Math.min(range.anchor, len), head: Math.min(range.head, len) },
      annotations: Transaction.addToHistory.of(false),
    }).state;
  }

  // Active textarea selection as anchor/head (head = caret), preserving
  // direction, for feeding decidePairedEdit.
  private taSelection(ta: HTMLTextAreaElement): { anchor: number; head: number } {
    return ta.selectionDirection === 'backward'
      ? { anchor: ta.selectionEnd, head: ta.selectionStart }
      : { anchor: ta.selectionStart, head: ta.selectionEnd };
  }

  // Apply a PairedEdit to a textarea: changes (original-doc coordinates, applied
  // right-to-left so earlier offsets stay valid) then the new selection with its
  // direction. One synchronous edit, so syncToDoc records it as a single step.
  private applyPairedEdit(ta: HTMLTextAreaElement, edit: PairedEdit): void {
    for (const c of [...edit.changes].sort((a, b) => b.from - a.from)) {
      ta.setRangeText(c.insert, c.from, c.to, 'preserve');
    }
    const lo = Math.min(edit.anchor, edit.head);
    const hi = Math.max(edit.anchor, edit.head);
    ta.setSelectionRange(lo, hi, edit.anchor <= edit.head ? 'forward' : 'backward');
  }

  // Apply a formatting command to whichever editor is active (Source View or the
  // active preview textarea). Driven by the native Format menu and its
  // accelerators, so the keyboard path lives in the menu, not in the webview.
  applyFormat(kind: 'bold' | 'italic' | 'strike' | 'math' | 'link'): void {
    const marker =
      kind === 'bold' ? '**'
      : kind === 'italic' ? '_'
      : kind === 'strike' ? '~~'
      : kind === 'math' ? '$$'
      : null;

    // Run on the shared op queue so it never races an in-flight Enter / paste /
    // merge or a Source View transition.
    void this.enqueueOp(async () => {
      if (this.sourceView.isActive()) {
        this.sourceView.applyFormat(marker);
        return;
      }

      if (this.activeBlockId === null) return;
      const id = this.activeBlockId;
      const ta = this.blockEl(id)?.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      const sel = this.taSelection(ta);
      const edit = marker !== null
        ? decideWrapEdit(ta.value, sel.anchor, sel.head, marker)
        : decideLinkEdit(ta.value, sel.anchor, sel.head);
      ta.focus();
      this.markCaret(this.caretDocRange());
      this.applyPairedEdit(ta, edit);
      this.autoResize(ta);
      this.updateStatus(id, ta);
      // Isolate: a formatting command is its own undo step.
      this.syncToDoc('input.type', true);
    });
  }

  private inputTypeToUserEvent(t: string | undefined): string | undefined {
    switch (t) {
      case 'insertCompositionText':
        return 'input.type.compose';
      case 'insertText':
      case 'insertLineBreak':
      case 'insertParagraph':
        return 'input.type';
      case 'insertFromPaste':
        return 'input.paste';
      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteByCut':
        return 'delete';
      default:
        return 'input';
    }
  }

  async undo(): Promise<void> {
    return this.runHistory(undo);
  }

  async redo(): Promise<void> {
    return this.runHistory(redo);
  }

  // Menu Undo/Redo (and any single entry point): route to CodeMirror's own
  // history in Source View, or our unified history in preview.
  async undoActive(): Promise<void> {
    if (this.sourceView.isActive()) { this.sourceView.undo(); return; }
    return this.runHistory(undo);
  }

  async redoActive(): Promise<void> {
    if (this.sourceView.isActive()) { this.sourceView.redo(); return; }
    return this.runHistory(redo);
  }

  // Run an undo/redo against the persistent state (headless - no view needed),
  // then rebuild the preview from the result. Serialized with Source View
  // transitions so it can't race a toggle.
  private runHistory(command: StateCommand): Promise<void> {
    return this.enqueueOp(async () => {
      if (this.cmSaved === null || this.sourceView.isActive()) return;
      this.syncToDoc(); // fold any not-yet-mirrored edit before stepping history
      let next: EditorState | null = null;
      command({ state: this.cmSaved, dispatch: (tr) => { next = tr.state; } });
      if (next === null) return; // nothing to undo/redo
      this.cmSaved = next;
      await this.applyHistoryState();
    });
  }

  // Rebuild the visible blocks from cmSaved (the source of truth) after undo/redo
  // and land the caret where CodeMirror restored it. Must not reset cmSaved.
  private async applyHistoryState(): Promise<void> {
    const state = this.cmSaved!;
    const md = state.doc.toString();
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const blocks = await invoke<Block[]>('parse_document', { content: md });
    if (blocks.length === 0) {
      // Document undone to empty: keep an editable empty block but preserve the
      // history state (initEmpty rebuilds cmSaved fresh).
      const saved = this.cmSaved;
      await this.initEmpty();
      this.cmSaved = saved;
      return;
    }
    this.applyParsedBlocks(blocks);
    const target = this.globalToBlock(line.number, head - line.from + 1);
    if (target) {
      // Restore the selection too when both ends land in the same block (a
      // textarea can't span blocks, so a cross-block selection stays collapsed).
      let selEnd: number | undefined;
      const anchor = state.selection.main.anchor;
      if (anchor !== head) {
        const aLine = state.doc.lineAt(anchor);
        const aTarget = this.globalToBlock(aLine.number, anchor - aLine.from + 1);
        if (aTarget && aTarget.id === target.id) selEnd = aTarget.offset;
      }
      await this.activate(target.id, target.offset, selEnd);
      requestAnimationFrame(() => this.blockEl(target.id)?.scrollIntoView({ block: 'center' }));
    }
  }

  // Public API

  async initEmpty() {
    const block: Block = { id: this.genId(), markdown: '', html: '', kind: 'emptyLine' };
    this.blocks = [block];
    this.rebuildIndex();
    this.cmSaved = this.sourceView.createState('');
    this.renderAll();
    this.updateStats();
    await this.activate(block.id, 0);
  }

  // Replace the visible blocks with a freshly parsed set: drop the active block
  // (its id may no longer exist), copy the DTOs so we never mutate the caller's
  // array, rebuild the index, re-render and update stats. Does NOT touch cmSaved
  // (the document history) and does NOT restore the caret - each caller does that
  // itself (the caret/selection it restores differs), and the empty-document case
  // is handled by the caller too (its cmSaved policy differs).
  private applyParsedBlocks(blocks: Block[]): void {
    this.activeBlockId = null;
    this.blocks = blocks.map(b => ({ ...b }));
    this.rebuildIndex();
    this.renderAll();
    this.updateStats();
  }

  async loadBlocks(blocks: Block[]) {
    // New document: an empty parse starts a fresh empty block AND a fresh history
    // (initEmpty rebuilds cmSaved) - the old history must not leak into a new tab.
    if (blocks.length === 0) {
      await this.initEmpty();
      return;
    }
    this.applyParsedBlocks(blocks);
    this.cmSaved = this.sourceView.createState(this.blocks.map(b => b.markdown).join('\n'));
  }

  // Re-render every block's HTML from its Markdown (e.g. after the "Escape
  // unsafe HTML" setting changed, which only affects render_block output). Does
  // not touch the Markdown or undo history - just repaints the preview. Caller
  // skips this in Source View; exiting it re-renders from Markdown anyway.
  async rerenderHtml(): Promise<void> {
    return this.enqueueOp(async () => {
      // Commit and close the active block first: renderAll() removes its
      // textarea, but a stale activeBlockId would make the next click think the
      // block is still active and not reopen it.
      await this.deactivate();
      await Promise.all(this.blocks.map(async (b) => {
        b.html = await invoke<string>('render_block', { markdown: b.markdown, kind: b.kind });
      }));
      this.renderAll();
    });
  }

  flushActiveBlock(): void {
    if (this.activeBlockId === null) return;
    const idx = this.blockIndex.get(this.activeBlockId);
    if (idx === undefined) return;
    const ta = this.blockEl(this.activeBlockId)?.querySelector('textarea');
    if (ta) this.blocks[idx].markdown = ta.value;
  }

  async commit(): Promise<void> {
    await this.flushPendingOps(); // let a just-queued structural edit finish first
    if (!this.sourceView.isActive()) await this.deactivate();
  }

  getDocumentMarkdown(): string {
    if (this.sourceView.isActive()) {
      return this.sourceView.getMarkdown();
    }
    this.flushActiveBlock();
    return this.blocks.map(b => b.markdown).join('\n');
  }

  // Index & DOM helpers

  private rebuildIndex() {
    this.blockIndex.clear();
    this.blocks.forEach((b, i) => this.blockIndex.set(b.id, i));
  }

  // Replace blocks[index .. index+deleteCount] with newBlocks, keeping the block
  // array, the id index, the DOM, and the document stats in sync - the splice /
  // rebuild / insert / remove dance nearly every structural edit repeats. New
  // elements land where the first removed block was; if nothing is removed, just
  // before the block that now follows the inserted run (or at the end). Clears
  // the active block; pass `caret` to focus a block afterward.
  private async replaceBlockRange(
    index: number,
    deleteCount: number,
    newBlocks: Block[],
    caret?: { id: number; offset: number },
  ): Promise<void> {
    const oldEls = this.blocks
      .slice(index, index + deleteCount)
      .map(b => this.blockEl(b.id))
      .filter((e): e is HTMLElement => e !== null);

    this.blocks.splice(index, deleteCount, ...newBlocks);
    this.rebuildIndex();

    let anchor: HTMLElement | null = oldEls[0] ?? null;
    if (!anchor) {
      const following = this.blocks[index + newBlocks.length];
      anchor = following ? this.blockEl(following.id) : null;
    }
    for (const b of newBlocks) {
      const el = this.createBlockEl(b);
      if (anchor) anchor.insertAdjacentElement('beforebegin', el);
      else this.container.appendChild(el);
    }
    for (const el of oldEls) el.remove();

    this.assignHeadingIds();
    this.activeBlockId = null;
    this.updateStats();
    if (caret) await this.activate(caret.id, caret.offset);
  }

  private genId(): number {
    return ++this.nextLocalId;
  }

  private blockEl(id: number): HTMLElement | null {
    return this.container.querySelector(`[data-block-id="${id}"]`);
  }

  private createBlockEl(block: Block): HTMLElement {
    const div = document.createElement('div');
    div.dataset.blockId = String(block.id);
    this.paintBlock(block, div);
    return div;
  }

  // Render a block's html into its element, with the same post-processing as a
  // freshly created block (checkboxes, heading ids, math, code highlighting).
  private paintBlock(block: Block, el: HTMLElement) {
    el.className = 'marku-block' + (block.kind === 'emptyLine' ? ' empty-line' : '');
    el.innerHTML = block.html;
    this.enableCheckboxes(el);
    this.resolveLocalImages(el);
    // While building a not-yet-inserted element (renderAll, replaceBlockRange)
    // the document pass runs after insertion; for an in-place repaint it runs now.
    if (el.isConnected) this.assignHeadingIds();
    this.renderMath(el);
    // Highlight fenced code and render mermaid diagrams by what the HTML actually
    // contains, not the block kind: a fenced code block can live inside a list or
    // blockquote (kind 'list'/'line'), and those need Prism/Mermaid too.
    if (el.querySelector('pre > code[class*="language-"]')) {
      Prism.highlightAllUnder(el);
      void this.renderMermaid(el);
    }
  }

  // Assign heading ids across the whole rendered document so anchors resolve
  // document-wide, not per isolated block. Rules: keep a non-empty id the
  // parser already produced from `{#custom-id}`; otherwise slug the text; make
  // every id unique (name, name-1, name-2); fall back to `heading` when the
  // slug is empty (a heading of pure punctuation).
  private assignHeadingIds() {
    const used = new Set<string>();
    this.container.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      const heading = h as HTMLElement;
      // Recover a STABLE base for this heading - never the dedup suffix left from
      // a previous pass. Markers survive between passes but are wiped whenever the
      // block is repainted (innerHTML reset), so a fresh heading is re-derived:
      //  - data-mk-explicit-id: the parser's {#custom-id}, captured once and kept,
      //    so two identical {#custom} headings stay custom / custom-1 stably and
      //    the second reclaims `custom` if the first goes away;
      //  - data-mk-genid: the id is derived from the heading text;
      //  - neither (just (re)painted): a non-empty id is the parser's explicit id
      //    (capture it), otherwise derive the base from the text.
      const savedExplicit = heading.getAttribute('data-mk-explicit-id');
      let base: string;
      if (savedExplicit !== null) {
        base = savedExplicit;
      } else if (heading.hasAttribute('data-mk-genid')) {
        base = this.slugify(heading.innerText) || 'heading';
      } else {
        const current = (heading.getAttribute('id') ?? '').trim();
        if (current !== '') {
          heading.setAttribute('data-mk-explicit-id', current);
          base = current;
        } else {
          heading.setAttribute('data-mk-genid', '');
          base = this.slugify(heading.innerText) || 'heading';
        }
      }
      let id = base;
      let n = 1;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      heading.id = id;
    });
  }

  // Unicode-aware slug: keep letters/digits of any script (incl. Cyrillic),
  // \w alone drops them. Spaces → dashes.
  private slugify(text: string): string {
    return text.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-');
  }

  private async renderMermaid(el: HTMLElement) {
    // A block can hold more than one diagram (e.g. two mermaid fences in a list),
    // so render every mermaid code element, not just the first.
    const codeEls = el.querySelectorAll('code.language-mermaid');
    const blockId = (el.closest('[data-block-id]') as HTMLElement | null)?.dataset.blockId
      ?? el.dataset.blockId ?? String(this.genId());
    let i = 0;
    for (const codeEl of codeEls) {
      const pre = codeEl.closest('pre');
      if (!pre) continue;
      const source = codeEl.textContent ?? '';
      const id = `mermaid-${blockId}-${i++}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.innerHTML = svg;
        pre.replaceWith(div);
      } catch { /* leave as code block on error */ }
    }
  }

  async setMermaidTheme(theme: string) {
    mermaid.initialize({ startOnLoad: false, theme: theme as 'default' | 'neutral' | 'dark' | 'forest' });
    // Re-render diagrams already on screen - their source survives in block.html.
    for (const block of this.blocks) {
      if (block.id === this.activeBlockId) continue;        // don't clobber an open editor
      if (!block.html.includes('language-mermaid')) continue;
      const el = this.blockEl(block.id);
      if (!el) continue;
      // Full repaint, not just mermaid: re-setting innerHTML would otherwise drop
      // the block's checkboxes and KaTeX. paintBlock re-runs the whole pipeline.
      this.paintBlock(block, el);
    }
  }

  private renderMath(el: HTMLElement) {
    el.querySelectorAll('.math-inline').forEach(span => {
      try {
        katex.render(span.textContent ?? '', span as HTMLElement, { throwOnError: false, displayMode: false });
      } catch { /* ignore */ }
    });
    el.querySelectorAll('.math-display').forEach(span => {
      try {
        katex.render(span.textContent ?? '', span as HTMLElement, { throwOnError: false, displayMode: true });
      } catch { /* ignore */ }
    });
  }

  private enableCheckboxes(el: HTMLElement) {
    // Rust tags each GFM task checkbox with data-marku-task-index during render
    // (the index already matches toggle_task), so we just enable those - no
    // structural guessing. A raw <input> from inline HTML has no such attribute
    // and is left alone.
    el.querySelectorAll('input[data-marku-task-index]').forEach(cb => {
      (cb as HTMLInputElement).removeAttribute('disabled');
    });
  }

  // Point local <img> sources (relative or file://) at the asset protocol,
  // resolved against the open file's directory. http(s), data: and asset: URLs
  // are left alone.
  private resolveLocalImages(el: HTMLElement) {
    el.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src');
      if (!src) return;
      let path: string;
      if (/^file:\/\//i.test(src)) {
        path = decodeURIComponent(new URL(src).pathname);
        if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
      } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) || src.startsWith('//')) {
        return;
      } else {
        const base = this.getBaseDir?.();
        if (!base) return;
        const rel = decodeURIComponent(src.split(/[?#]/)[0]);
        path = rel.startsWith('/') ? rel : `${base}/${rel}`;
      }
      img.setAttribute('src', convertFileSrc(path));
    });
  }

  private renderAll() {
    this.container.innerHTML = '';
    for (const block of this.blocks) {
      this.container.appendChild(this.createBlockEl(block));
    }
    this.assignHeadingIds();
  }

  // Activation / deactivation

  private async activate(id: number, cursorPos?: number, selEnd?: number) {
    if (this.activeBlockId !== null && this.activeBlockId !== id) {
      await this.deactivate();
    }
    if (this.activeBlockId === id) return;

    const idx = this.blockIndex.get(id);
    if (idx === undefined) return;
    const block = this.blocks[idx];
    const el = this.blockEl(id);
    if (!el) return;

    this.activeBlockId = id;

    const ta = document.createElement('textarea');
    ta.className = 'marku-textarea';
    ta.rows = 1;
    // Markdown and code: stop the OS from auto-rewriting what you type
    // (capitalizing Print, smart quotes). Spell-check underlines stay on.
    ta.autocapitalize = 'off';
    ta.setAttribute('autocorrect', 'off');
    // WebKit doesn't paint a caret in a genuinely empty textarea (its shadow
    // content has no child to anchor a line box to) - a non-empty placeholder
    // gives it one, invisibly, without showing placeholder text on screen.
    ta.placeholder = ' ';
    ta.value = block.markdown;
    el.innerHTML = '';
    el.appendChild(ta);

    this.autoResize(ta);

    const pos = cursorPos !== undefined ? cursorPos : ta.value.length;
    // Set the selection synchronously (not only in rAF) so a syncToDoc right
    // after a structural op records the real caret, not the textarea's default
    // of 0. `pos` is the caret/head; `selEnd` (if given and different) is the
    // other end, so undo can restore a within-block selection, not just a caret.
    const applySelection = () => {
      if (selEnd === undefined || selEnd === pos) {
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
      } else {
        ta.setSelectionRange(Math.min(pos, selEnd), Math.max(pos, selEnd), pos < selEnd ? 'backward' : 'forward');
      }
    };
    applySelection();
    requestAnimationFrame(() => {
      ta.focus();
      applySelection();
    });

    ta.addEventListener('keydown', (e) => this.handleKeydown(e, id));
    ta.addEventListener('paste', (e) => this.handlePaste(e, id));
    ta.addEventListener('beforeinput', (e) => {
      const ie = e as InputEvent;
      // Auto-pair / wrap on a plain typed character (skip IME composition).
      if (ie.inputType === 'insertText' && ie.data?.length === 1 && !ie.isComposing) {
        const sel = this.taSelection(ta);
        const edit = decidePairedEdit(ta.value, sel.anchor, sel.head, { type: 'insert', char: ie.data });
        if (edit) {
          ie.preventDefault();
          this.markCaret(this.caretDocRange()); // pre-edit caret for undo
          this.applyPairedEdit(ta, edit);
          this.autoResize(ta);
          this.updateStatus(id, ta);
          this.syncToDoc('input.type');
          return;
        }
      }
      // Otherwise just record the pre-edit caret; the input handler below records
      // the change after the browser applies it.
      this.markCaret(this.caretDocRange());
    });
    ta.addEventListener('input', (e) => {
      this.autoResize(ta);
      this.updateStatus(id, ta);
      this.syncToDoc(this.inputTypeToUserEvent((e as InputEvent).inputType));
    });
    ta.addEventListener('keyup', () => this.updateStatus(id, ta));
    ta.addEventListener('mouseup', () => this.updateStatus(id, ta));

    this.updateStatus(id, ta);
  }

  private async deactivate() {
    if (this.activeBlockId === null || this.isDeactivating) return;
    this.isDeactivating = true;

    const id = this.activeBlockId;
    this.activeBlockId = null;
    this.updateStatus(); // focus left the block → clear Ln/Col

    const idx = this.blockIndex.get(id);
    if (idx === undefined) { this.isDeactivating = false; return; }

    const el = this.blockEl(id);
    const ta = el?.querySelector('textarea');
    if (!el || !ta) { this.isDeactivating = false; return; }

    const newMarkdown = ta.value;
    const block = this.blocks[idx];

    // Single line that belongs to the block above (a `: definition` under its
    // term, a table row under its table, a list item under its list): fold them.
    // Same parser check as Enter, here for the case where focus just leaves
    // without an Enter (e.g. a blank line between them was deleted).
    if (idx > 0 && (block.kind === 'line' || block.kind === 'emptyLine')) {
      const prev = this.blocks[idx - 1];
      if (await this.tryMergeBlocks(prev, newMarkdown)) {
        this.blocks.splice(idx, 1);
        this.rebuildIndex();
        el.remove();
        this.paintBlock(prev, this.blockEl(prev.id)!);
        this.updateStats();
        this.isDeactivating = false;
        return;
      }
    }

    // Re-parse the edited content and let the parser classify and split it - the
    // single source of Markdown rules, so leaving a block reclassifies it exactly
    // like a full re-render (no manual kind guessing). Usually one block: keep
    // this block's id and repaint in place. If the edit introduced a block
    // boundary (a blank line splitting a list, a closed fence with trailing
    // text), expand into the parsed set. parse_document never returns empty -
    // even "" yields one emptyLine block.
    const parsed = await invoke<Block[]>('parse_document', { content: newMarkdown });
    if (parsed.length === 1) {
      block.markdown = parsed[0].markdown;
      block.kind = parsed[0].kind;
      block.html = parsed[0].html;
      this.paintBlock(block, el);
      this.updateStats();
      this.isDeactivating = false;
      return;
    }
    await this.replaceBlockRange(idx, 1, parsed);
    this.isDeactivating = false;
  }

  // Container click

  private async handleContainerClick(e: MouseEvent) {
    const target = e.target as HTMLElement;

    const link = target.closest('a') as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        // Heading hrefs are URL-encoded (Cyrillic → %..); decode to match ids.
        let id = href.slice(1);
        try { id = decodeURIComponent(id); } catch { /* keep raw */ }
        const el = document.getElementById(id);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (href.startsWith('http://') || href.startsWith('https://')) {
        await openUrl(href);
      }
      return;
    }

    // checkbox toggle in task lists
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'checkbox') {
      // Only Rust-tagged task checkboxes carry data-marku-task-index. A raw HTML
      // checkbox has none - leave it to behave natively (no preventDefault).
      const taskIndex = (target as HTMLElement).dataset.markuTaskIndex;
      if (taskIndex === undefined) return;
      e.preventDefault();
      // Capture the index now (the DOM is rebuilt on repaint) and queue the toggle
      // so rapid clicks can't lose an update.
      const blockEl = target.closest('[data-block-id]') as HTMLElement | null;
      if (blockEl) {
        const blockId = Number(blockEl.dataset.blockId);
        const index = Number(taskIndex);
        // On the shared op queue so rapid clicks can't lose an update and so a
        // toggle can't race an undo.
        void this.enqueueOp(() => this.toggleCheckbox(blockId, index));
      }
      return;
    }

    const blockEl = target.closest('[data-block-id]') as HTMLElement | null;

    if (!blockEl) {
      if (this.blocks.length > 0) {
        const last = this.blocks[this.blocks.length - 1];
        const lastEl = this.blockEl(last.id);
        const belowAll = lastEl ? e.clientY > lastEl.getBoundingClientRect().bottom : false;
        if (belowAll && last.id !== this.activeBlockId) {
          await this.activate(last.id, last.markdown.length);
          return;
        }
      }
      await this.deactivate();
      return;
    }

    const id = Number(blockEl.dataset.blockId);
    if (id === this.activeBlockId) return;
    await this.activate(id);
  }

  // Checkbox toggle

  // Toggle the task checkbox at document-order `index` in block `blockId`. Runs
  // on opChain, so it reads the current (already-updated) markdown rather than a
  // stale snapshot. The parser owns which lines are task items: we send the index
  // and let Rust flip the matching TaskListMarker - no list-syntax regex.
  private async toggleCheckbox(blockId: number, index: number) {
    const idx = this.blockIndex.get(blockId);
    if (idx === undefined) return;
    const block = this.blocks[idx];
    const el = this.blockEl(blockId);
    if (!el) return;

    const result = await invoke<{ markdown: string; html: string }>('toggle_task', {
      markdown: block.markdown,
      kind: block.kind,
      index,
    });
    block.markdown = result.markdown;
    block.html = result.html;
    // Full repaint so nested checkboxes, math, code highlighting and mermaid all
    // re-run, not just the checkbox state.
    this.paintBlock(block, el);
    this.syncToDoc(undefined, true);
  }

  // Paste handling

  private handlePaste(e: ClipboardEvent, id: number): void {
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (!pasted.includes('\n')) return; // single-line paste - let browser handle it

    e.preventDefault();

    const ta = this.blockEl(id)?.querySelector('textarea');
    if (!ta) return;

    // Capture the synchronous inputs now; the reparse runs on the op queue so a
    // multi-line paste can't race an undo (which would let the late paste result
    // overwrite the undone document).
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const caretOffset = this.caretDocRange();

    void this.enqueueOp(async () => {
      this.markCaret(caretOffset);
      const idx = this.blockIndex.get(id);
      if (idx === undefined) return;
      const combined = before + pasted + after;

      // Fold the previous block into the reparse when it could group with the
      // pasted text (a table/list/blockquote body row, etc.). Pasting into the
      // empty line that separated two structures removes that separator, so the
      // pasted rows now sit flush against the block above. Reparsing them in
      // isolation would leave them as loose literals until the next full render;
      // including `prev` makes the live result group exactly like a full reparse.
      const prev = idx > 0 ? this.blocks[idx - 1] : null;
      const foldPrev = prev !== null && prev.kind !== 'emptyLine' && prev.markdown.trim() !== '';
      const prefix = foldPrev ? prev!.markdown + '\n' : '';

      const parsed = await invoke<Block[]>('parse_document', { content: prefix + combined });
      if (parsed.length === 0) return;

      // Land the caret at the end of the pasted text. That is a global offset in
      // the reparsed text (prefix + combined); map it to a specific parsed block +
      // local offset, because the surrounding text can span several blocks - the
      // end of the paste is not necessarily in the last block. Blocks rejoin with
      // one '\n', so advance by len + 1.
      const target = prefix.length + before.length + pasted.length;
      const last = parsed[parsed.length - 1];
      let caretPos = { id: last.id, offset: last.markdown.length };
      let pos = 0;
      for (const b of parsed) {
        const len = b.markdown.length;
        if (target <= pos + len) {
          caretPos = { id: b.id, offset: target - pos };
          break;
        }
        pos += len + 1;
      }
      const replaceIndex = foldPrev ? idx - 1 : idx;
      const deleteCount = foldPrev ? 2 : 1;
      await this.replaceBlockRange(replaceIndex, deleteCount, parsed, caretPos);
      this.syncToDoc(undefined, true);
    });
  }

  // Keyboard handling

  private async handleKeydown(e: KeyboardEvent, id: number) {
    const ta = e.target as HTMLTextAreaElement;
    const idx = this.blockIndex.get(id)!;
    const block = this.blocks[idx];
    const isSingleLine = block.kind === 'line' || block.kind === 'emptyLine';

    // Backspace inside an empty auto-pair deletes both brackets in one edit (so
    // Cmd+Z restores the whole pair in one step). Only fires when the caret sits
    // directly between an opener and its matching closer; otherwise falls through
    // to the ordinary Backspace / block-merge handling below.
    if (e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
      const sel = this.taSelection(ta);
      const edit = decidePairedEdit(ta.value, sel.anchor, sel.head, { type: 'backspace' });
      if (edit) {
        e.preventDefault();
        this.markCaret(this.caretDocRange());
        this.applyPairedEdit(ta, edit);
        this.autoResize(ta);
        this.updateStatus(id, ta);
        this.syncToDoc('delete');
        return;
      }
    }

    // Tab inserts two spaces instead of moving focus out of the textarea.
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const start = ta.selectionStart;
      this.markCaret(this.caretDocRange());
      ta.setRangeText('  ', start, ta.selectionEnd, 'end');
      this.autoResize(ta);
      this.updateStatus(id, ta);
      this.syncToDoc(undefined, true); // setRangeText fires no input event
      return;
    }

    // Enter in a single-line block, or in a reopened code block (so the closing
    // fence is recognized even after the block was committed - a code block is
    // multi-line, kind 'codeBlock', not single-line).
    if (e.key === 'Enter' && (isSingleLine || block.kind === 'codeBlock')) {
      const value = ta.value;
      const textBeforeCursor = value.slice(0, ta.selectionStart);
      // Opening fence: 3+ backticks/tildes at <=3 spaces of indent. trimStart()
      // alone would also accept 4+ spaces, but 4 is the indented-code threshold
      // in parser.rs (opens_code_fence), so the indent must be checked or the
      // live editor would open a fence the re-parse keeps as a plain line.
      const firstLine = value.split('\n')[0];
      const openIndent = firstLine.length - firstLine.trimStart().length;
      const fenceMatch = openIndent <= 3
        ? firstLine.trimStart().match(/^(`{3,}|~{3,})/)
        : null;

      if (fenceMatch) {
        const openFence = fenceMatch[1];
        const fenceChar = openFence[0];
        const lines = textBeforeCursor.split('\n');
        const rawLine = lines[lines.length - 1];
        const indent = rawLine.length - rawLine.trimStart().length;
        const currentLine = rawLine.trim();
        // Closing fence: same char, length >= opener, <=3 spaces of indent -
        // matches parser.rs (else the UI closes a fence the re-parse keeps as
        // code). Holds both while typing a new fence and inside a reopened code
        // block: Enter right after the closing fence finalizes; Enter anywhere
        // else (mid-code, blank lines included) just inserts a newline.
        const isClosingFence = lines.length > 1
          && indent <= 3
          && currentLine.length >= openFence.length
          && [...currentLine].every(c => c === fenceChar);

        if (isClosingFence) {
          e.preventDefault();
          await this.runStructural(() => this.finalizeCodeBlock(ta, idx));
        } else {
          // still inside the code block - let the browser add a newline
          setTimeout(() => this.autoResize(ta), 0);
        }
        return;
      }

      // A reopened code block always starts with a fence, so we never reach here
      // for one - guard anyway so a stray code block gets a newline rather than
      // falling into the single-line paths below.
      if (!isSingleLine) {
        setTimeout(() => this.autoResize(ta), 0);
        return;
      }

      // Display math, but only the multi-line form (opening `$$` alone on its
      // first line). A single-line `$$ ... $$` is an ordinary line that pulldown
      // renders as display math on its own, so let Enter split it like any line.
      if (value.split('\n')[0].trim() === '$$') {
        const lines = textBeforeCursor.split('\n');
        const currentLine = lines[lines.length - 1].trim();
        const isClosing = lines.length > 1 && currentLine === '$$';

        if (isClosing) {
          e.preventDefault();
          await this.runStructural(() => this.finalizeDisplayMath(ta, idx));
        } else {
          setTimeout(() => this.autoResize(ta), 0);
        }
        return;
      }

      e.preventDefault();
      await this.runStructural(() => this.splitBlock(id, ta.selectionStart));
      return;
    }

    // Multi-line list/table: a second consecutive Enter (an Enter pressed while
    // the caret already sits on a blank line) ends the block - a blank line is a
    // block separator in markdown. Commit everything above the blank line and
    // drop into a fresh empty block below. Code blocks are excluded: blank lines
    // are valid content there.
    if (e.key === 'Enter' && (block.kind === 'list' || block.kind === 'table')) {
      const textBeforeCursor = ta.value.slice(0, ta.selectionStart);
      const lineStart = textBeforeCursor.lastIndexOf('\n');
      const currentLine = textBeforeCursor.slice(lineStart + 1);
      if (lineStart !== -1 && currentLine.trim() === '') {
        const before = ta.value.slice(0, lineStart);
        if (before.trim() !== '') {
          e.preventDefault();
          await this.runStructural(() => this.splitMultiline(id, before, ta.value.slice(ta.selectionStart)));
          return;
        }
      }
    }

    if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      // Merge only when it can't glue a multi-line block's content onto the line
      // above. Gate on the actual content being one line, not on kind: display
      // math, blockquotes and definition lists are all kind 'line' yet span
      // several lines, so an isSingleLine check would wrongly let them merge.
      // A blank line above is always safe to drop regardless.
      const isOneLine = !ta.value.includes('\n');
      const prevIsEmpty = idx > 0 && this.blocks[idx - 1].kind === 'emptyLine';
      if (isOneLine || prevIsEmpty) {
        e.preventDefault();
        await this.runStructural(() => this.mergeWithPrev(id));
        return;
      }
    }

    // Move to the adjacent block only from the first/last VISUAL row of the
    // textarea, not the first/last logical line: a long paragraph is one line
    // that soft-wraps over several rows, and Up/Down should walk those rows
    // first (native does that when we don't preventDefault).
    if (e.key === 'ArrowUp' && this.caretOnEdgeRow(ta).first) {
      e.preventDefault();
      await this.navigatePrev(id, ta.selectionStart);
      return;
    }

    if (e.key === 'ArrowDown' && this.caretOnEdgeRow(ta).last) {
      e.preventDefault();
      await this.navigateNext(id, ta);
      return;
    }
  }

  // Is the caret on the first / last visual (wrapped) row of the textarea?
  // A textarea exposes no caret coordinates, so measure with a hidden mirror
  // div that copies the textarea's box + font and holds the text up to the
  // caret plus a marker; the marker's offsetTop tells us its row.
  private caretOnEdgeRow(ta: HTMLTextAreaElement): { first: boolean; last: boolean } {
    const cs = getComputedStyle(ta);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    let lh = parseFloat(cs.lineHeight);
    if (!lh) lh = (parseFloat(cs.fontSize) || 16) * 1.2;

    const mirror = document.createElement('div');
    const s = mirror.style;
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.boxSizing = 'border-box';
    s.width = `${ta.clientWidth}px`;
    s.height = 'auto';
    s.whiteSpace = 'pre-wrap';
    s.overflowWrap = 'break-word';
    s.wordBreak = cs.wordBreak;
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
      'letterSpacing', 'textIndent', 'tabSize'] as const) {
      s[p] = cs[p];
    }

    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionStart);
    mirror.textContent = before;
    const marker = document.createElement('span');
    marker.textContent = after.length ? after[0] : '.';
    mirror.appendChild(marker);
    mirror.appendChild(document.createTextNode(after.slice(1)));
    document.body.appendChild(mirror);

    const caretTop = marker.offsetTop - padTop;
    const contentH = mirror.scrollHeight - padTop - padBottom;
    document.body.removeChild(mirror);

    return { first: caretTop < lh, last: caretTop >= contentH - lh - 1 };
  }

  // Finalize display math block (closing $$ + Enter)

  private async finalizeDisplayMath(ta: HTMLTextAreaElement, idx: number) {
    const block = this.blocks[idx];
    block.markdown = ta.value;
    block.kind = 'line';
    block.html = await invoke<string>('render_block', { markdown: ta.value, kind: 'line' });

    const nextBlock: Block = { id: this.genId(), markdown: '', html: '', kind: 'emptyLine' };
    await this.replaceBlockRange(idx, 1, [block, nextBlock], { id: nextBlock.id, offset: 0 });
  }

  // Finalize code block (closing fence + Enter)

  private async finalizeCodeBlock(ta: HTMLTextAreaElement, idx: number) {
    const cursor = ta.selectionStart;
    const codeContent = ta.value.slice(0, cursor);
    const remainder = ta.value.slice(cursor).replace(/^\n/, '').trimStart();

    const block = this.blocks[idx];
    block.markdown = codeContent;
    block.kind = 'codeBlock';
    block.html = await invoke<string>('render_block', { markdown: codeContent, kind: 'codeBlock' });

    const nextKind: BlockKind = remainder.trim() === '' ? 'emptyLine' : 'line';
    const nextHtml = await invoke<string>('render_block', { markdown: remainder, kind: nextKind });
    const nextBlock: Block = { id: this.genId(), markdown: remainder, html: nextHtml, kind: nextKind };

    await this.replaceBlockRange(idx, 1, [block, nextBlock], { id: nextBlock.id, offset: 0 });
  }

  // Split (Enter)

  private async splitBlock(id: number, cursor: number) {
    if (this.isDeactivating) return;
    const idx = this.blockIndex.get(id);
    if (idx === undefined) return;
    const block = this.blocks[idx];
    const el = this.blockEl(id);
    if (!el) return;
    const ta = el.querySelector('textarea');
    const current = ta ? ta.value : block.markdown;

    const before = current.slice(0, cursor);
    const after = current.slice(cursor);

    // The tail after the caret is kept verbatim: no trimming, no header-marker
    // stripping. The re-parse decides its real kind, so `hello |#tag` keeps
    // `#tag` and leading spaces survive.

    // Does the line we just finished belong to the block above? Ask the parser:
    // if prev + before collapse into one block, fold them (a table row joins its
    // table, a list item joins its list, `: def` joins its term). The text after
    // the cursor becomes the new block. The parser is the single source of truth,
    // so the live editor groups exactly like a full re-render - no heuristics.
    const prev = idx > 0 ? this.blocks[idx - 1] : null;
    if (prev && await this.tryMergeBlocks(prev, before)) {
      // tryMergeBlocks already folded `before` into prev (in place). Replace
      // prev + the current block with [prev (kept), tail]: the current block's
      // text moved into prev, the text after the cursor becomes the new block.
      const newBlock = await this.makeLineBlock(after);
      await this.replaceBlockRange(idx - 1, 2, [prev, newBlock], { id: newBlock.id, offset: 0 });
      return;
    }

    // No merge: ordinary split into before (stays in this block) + after (new
    // block). The block keeps its id; replaceBlockRange repaints it in place.
    block.markdown = before;
    block.kind = before.trim() === '' ? 'emptyLine' : 'line';
    block.html = await invoke<string>('render_block', { markdown: before, kind: block.kind });

    const newBlock = await this.makeLineBlock(after);
    await this.replaceBlockRange(idx, 1, [block, newBlock], { id: newBlock.id, offset: 0 });
  }

  // Split a multi-line block (list/table) at a blank line the user just typed.
  // `before` is the text above the blank line - re-parsed into its real blocks
  // (the list/table itself, plus anything that split off). `after` is whatever
  // followed the caret (usually empty) and becomes a fresh block the caret lands
  // in.
  private async splitMultiline(id: number, before: string, after: string) {
    const idx = this.blockIndex.get(id);
    if (idx === undefined) return;

    const parsed = await invoke<Block[]>('parse_document', { content: before });
    const tail = await this.makeLineBlock(after);
    await this.replaceBlockRange(idx, 1, [...parsed, tail], { id: tail.id, offset: 0 });
  }

  // Build a fresh single-line block (empty line or paragraph) with its html.
  private async makeLineBlock(text: string): Promise<Block> {
    const kind: BlockKind = text.trim() === '' ? 'emptyLine' : 'line';
    const html = await invoke<string>('render_block', { markdown: text, kind });
    return { id: this.genId(), markdown: text, html, kind };
  }

  // Merge (Backspace at pos 0)

  private async mergeWithPrev(id: number) {
    if (this.isDeactivating) return;
    const idx = this.blockIndex.get(id);
    if (idx === undefined || idx === 0) return;

    const block = this.blocks[idx];
    const prev = this.blocks[idx - 1];
    const ta = this.blockEl(id)?.querySelector('textarea');
    const currentMarkdown = ta ? ta.value : block.markdown;
    const joinPos = prev.markdown.length; // caret lands at the end of prev

    // Deleting an empty line (a blank block separator): drop it, then ask the
    // parser whether the blocks on either side now form one. E.g. two lists with
    // the blank line between them deleted reunite into a single list. The caret
    // goes to the end of prev (the seam).
    if (currentMarkdown.trim() === '') {
      this.activeBlockId = null;
      this.blockEl(id)?.remove();
      this.blocks.splice(idx, 1);
      this.rebuildIndex();
      const next = this.blocks[idx]; // the block that followed the empty line
      if (next && await this.tryMergeBlocks(prev, next.markdown)) {
        this.blockEl(next.id)?.remove();
        this.blocks.splice(idx, 1);
        this.rebuildIndex();
      }
      this.updateStats();
      await this.activate(prev.id, joinPos);
      return;
    }

    // Prev is just a blank separator: drop it and leave the current block as is
    // (its textarea stays active, caret at the start). Safe for any kind - no
    // text is glued together - so this is what lets Backspace at the very start
    // of a code block / list / table remove the blank line above it.
    if (prev.kind === 'emptyLine') {
      this.blockEl(prev.id)?.remove();
      this.blocks.splice(idx - 1, 1);
      this.rebuildIndex();
      this.updateStats();
      return;
    }

    // Prev is multi-line (code/list/table): don't concatenate onto one line, just
    // move into it. deactivate() must run with activeBlockId still set so it
    // flushes this block's textarea into block.markdown and re-renders it (it
    // clears activeBlockId itself). Nulling it first made deactivate() bail and
    // lose the edits, leaving a stray textarea.
    if (prev.kind === 'codeBlock' || prev.kind === 'list' || prev.kind === 'table') {
      await this.deactivate();
      await this.activate(prev.id, prev.markdown.length);
      return;
    }

    // Two plain lines: Backspace removes the boundary, joining them into one.
    // prev keeps its id (passed back into the range), caret lands at the seam.
    const merged = prev.markdown + currentMarkdown;
    prev.markdown = merged;
    prev.kind = merged.trim() === '' ? 'emptyLine' : 'line';
    prev.html = await invoke<string>('render_block', { markdown: merged, kind: prev.kind });
    await this.replaceBlockRange(idx - 1, 2, [prev], { id: prev.id, offset: joinPos });
  }

  // Block grouping - delegated to the parser

  // Ask the parser whether `current` continues `prev`: join them and see if they
  // collapse into a single block (a table row joining its table, a list item its
  // list, `: def` its term, `> b` its quote). On a match, `prev` absorbs the text
  // (markdown/kind/html updated in place, its id and element kept) and we return
  // true; the caller drops the now-empty source block. The parser is the single
  // source of truth, so live grouping matches a full re-render exactly - no
  // per-construct heuristics. A blank line is a block separator, so an empty
  // `prev` or `current` never merges.
  private async tryMergeBlocks(prev: Block, current: string): Promise<boolean> {
    if (prev.kind === 'emptyLine' || prev.markdown.trim() === '' || current.trim() === '') {
      return false;
    }
    const combined = prev.markdown + '\n' + current;
    const parsed = await invoke<Block[]>('parse_document', { content: combined });
    if (parsed.length !== 1) return false;
    prev.markdown = parsed[0].markdown;
    prev.kind = parsed[0].kind;
    prev.html = parsed[0].html;
    return true;
  }

  // Arrow navigation

  private async navigatePrev(id: number, colHint: number) {
    const idx = this.blockIndex.get(id)!;
    if (idx === 0) return;
    const prevId = this.blocks[idx - 1].id;
    await this.deactivate();
    const prevIdx = this.blockIndex.get(prevId);
    const prev = prevIdx !== undefined ? this.blocks[prevIdx] : null;
    if (!prev) return;
    const lastLine = prev.markdown.split('\n').pop() ?? '';
    const pos = prev.markdown.length - lastLine.length + Math.min(colHint, lastLine.length);
    await this.activate(prev.id, pos);
  }

  private async navigateNext(id: number, ta: HTMLTextAreaElement) {
    const idx = this.blockIndex.get(id)!;
    if (idx >= this.blocks.length - 1) return;
    const nextId = this.blocks[idx + 1].id;
    const textBefore = ta.value.slice(0, ta.selectionStart);
    const lastNl = textBefore.lastIndexOf('\n');
    const col = ta.selectionStart - (lastNl + 1);
    await this.deactivate();
    const nextIdx = this.blockIndex.get(nextId);
    const next = nextIdx !== undefined ? this.blocks[nextIdx] : null;
    if (!next) return;
    const firstLine = next.markdown.split('\n')[0];
    await this.activate(next.id, Math.min(col, firstLine.length));
  }

  // Status bar

  private updateStatus(id?: number, ta?: HTMLTextAreaElement) {
    if (id === undefined || ta === undefined) {
      this.statusLn.textContent = '';
      this.statusCol.textContent = '';
      return;
    }
    const idx = this.blockIndex.get(id);
    if (idx === undefined) return;

    const { ln, col } = this.blockCaret(idx, ta);
    this.statusLn.textContent = `Ln ${ln}`;
    this.statusCol.textContent = `Col ${col}`;
  }

  // Global 1-based (line, col) of the caret in the active block's textarea.
  // Same coordinate the status bar shows and CodeMirror reports - so it maps
  // straight across when switching Preview ↔ Source View.
  private blockCaret(idx: number, ta: HTMLTextAreaElement): { ln: number; col: number } {
    const startLine = this.blockStartLine(idx);
    // The general count works for single-line blocks too (zero newlines before
    // the caret). Blockquote, definition list and display math also carry
    // kind 'line' yet span several lines, so there is no single-line shortcut.
    const textBefore = ta.value.slice(0, ta.selectionStart);
    const linesBefore = textBefore.split('\n').length - 1;
    const lastNl = textBefore.lastIndexOf('\n');
    return { ln: startLine + linesBefore + 1, col: ta.selectionStart - (lastNl + 1) + 1 };
  }

  // Inverse of blockCaret: a global (line, col) → which block + textarea offset.
  // Used when leaving Source View to land the caret on the same spot.
  private globalToBlock(line: number, col: number): { id: number; offset: number } | null {
    if (this.blocks.length === 0) return null;
    const targetLine0 = line - 1;
    for (let idx = 0; idx < this.blocks.length; idx++) {
      const start = this.blockStartLine(idx);
      const lines = this.blocks[idx].markdown.split('\n');
      if (targetLine0 < start + lines.length) {
        const within = Math.max(0, Math.min(targetLine0 - start, lines.length - 1));
        let offset = 0;
        for (let i = 0; i < within; i++) offset += lines[i].length + 1;
        offset += Math.min(col - 1, lines[within].length);
        return { id: this.blocks[idx].id, offset };
      }
    }
    const last = this.blocks[this.blocks.length - 1];
    return { id: last.id, offset: last.markdown.length };
  }

  private blockStartLine(idx: number): number {
    let line = 0;
    for (let i = 0; i < idx; i++) {
      line += this.blocks[i].markdown.split('\n').length;
    }
    return line;
  }

  private updateStats() {
    const md = this.getDocumentMarkdown();
    const words = md.trim() === '' ? 0 : md.trim().split(/\s+/).length;
    const chars = md.length;
    this.statusStats.textContent = `${words} W  ${chars} Ch`;
  }

  // Textarea auto-resize

  private autoResize(ta: HTMLTextAreaElement) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
}
