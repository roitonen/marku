# Getting Started with Marku

Marku is a block-based Markdown editor: your document is a stack of blocks
(paragraphs, headings, lists, code, tables...), and each block is rendered live
as you write.

## Opening and creating files

- **New tab** - `Cmd+T`, or the `+` button in the tab bar.
- **Open a file** - `Cmd+O`. Recent files: `Cmd+Shift+O`.
- Each tab is one document. Switch tabs with `Cmd+[` / `Cmd+]` or `Cmd+1`...`Cmd+9`.

## Editing

- Click a block to edit its Markdown; click away (or move off it) to render it.
- Press `Enter` to split into a new block, `Backspace` at the start to merge up.
- Formatting shortcuts work on the selection: `Cmd+B` bold, `Cmd+I` italic,
  `Cmd+K` link. See **Keyboard Shortcuts** for the full list.

## Preview and Source View

- The normal view renders each block (this is the **Preview**).
- **`Cmd+E`** toggles **Source View** - the whole document as raw Markdown in a
  plain code editor. Useful for big edits, find-and-replace (`Cmd+F`), or
  recovering if some raw HTML breaks the preview.

## Saving

- **`Cmd+S`** saves. A new (unsaved) document asks where to save first.
- **`Cmd+Shift+S`** is Save As.
- The tab shows the file name; an unsaved document is `Untitled.md`.

That's the core loop. The **Markdown Guide** covers the syntax Marku supports.
