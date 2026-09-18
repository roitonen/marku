# Troubleshooting

## The preview looks broken

Raw HTML or CSS in the document (for example a stray `<style>` tag) can affect
the whole preview. Press **`Cmd+E`** to switch to **Source View**: it clears the
rendered preview and shows plain Markdown, so you can find and remove the
offending markup. Switching back rebuilds the preview from the Markdown.

## "Marku can't be opened" / unsigned app

If macOS blocks the app because it is not signed, open it once via
**right-click -> Open** (or System Settings -> Privacy & Security -> Open
Anyway). After that it launches normally.

## Where are my settings stored?

Settings and recent files live in the app data folder:

```
~/Library/Application Support/app.marku
```

Deleting that folder resets Marku to defaults.

## A file won't save

- Check you have write permission to the folder, and that the disk isn't full.
- If the original folder is gone (e.g. an unplugged drive), use
  **Save As** (`Cmd+Shift+S`) to write somewhere else.
- Marku writes atomically and reports the OS error in a dialog if the write
  fails - the previous file on disk is left untouched.

## Reverting changes

There is no autosave. Closing a tab with unsaved edits always asks first
(Save / Don't Save / Cancel), so you won't lose work by accident.
