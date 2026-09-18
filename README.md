# Marku

A desktop Markdown editor for creating and editing `.md` and `.markdown` files.
Click any paragraph, heading, list, or table to edit its Markdown, then click away to see the formatted result. Switch to Source View to edit the whole document as plain text.

**Website:** [https://marku.app/](https://marku.app/)

## Features

- Open multiple documents in tabs and quickly return to recent files.
- Work with tables, clickable task lists, and code with syntax highlighting.
- Write math with KaTeX and draw diagrams with Mermaid.
- Choose from 30 themes and adjust fonts, line spacing, content width, and word wrap.
- Use keyboard shortcuts and track word and character counts as you write.


![Marku App](https://marku.app/assets/marku-themes.webp)

## Development

Built with Tauri 2, Rust, TypeScript, and Vite. Uses CodeMirror 6 for source editing and pulldown-cmark for Markdown parsing.

Requires Node.js, npm, Rust, and the Tauri 2 system dependencies for your platform.

Run locally:

```sh
npm install
npm run tauri dev
```

Run tests:

```sh
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Build the desktop app:

```sh
npm run tauri build
```
