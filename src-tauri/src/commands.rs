//! Tauri commands invoked from the frontend, plus the small shared atomics they
//! rely on (block id counter and the quit flag).

use crate::parser::{BlockDto, BlockKind, parse_blocks, render_block_html, toggle_task_marker};
use crate::window::show_settings_window;
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{Emitter, Manager};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Set once the frontend has handled unsaved tabs and the app may exit.
pub(crate) static QUITTING: AtomicBool = AtomicBool::new(false);
/// Bumped per atomic save to give each temp file a unique name.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Paths macOS asked us to open (Finder double-click / Open With) that the
/// frontend has not taken yet. Kept here so a cold start does not lose them
/// when the event arrives before the frontend has registered its listener.
pub(crate) static PENDING_OPENS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

#[tauri::command]
pub fn take_opened_files() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPENS.lock().unwrap())
}

// Read a file, tagging a missing-file error with a stable `NOT_FOUND:` prefix so
// the frontend can tell "moved/deleted" (offer to drop the recent entry) from a
// transient permission/read failure (just report it) without parsing localized
// OS messages.
fn read_text(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("NOT_FOUND: {e}")
        } else {
            e.to_string()
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    QUITTING.store(true, Ordering::Relaxed);
    app.exit(0);
}

#[tauri::command]
pub fn parse_document(content: String) -> Vec<BlockDto> {
    parse_blocks(&content)
        .into_iter()
        .map(|(markdown, kind)| {
            let html = render_block_html(&markdown, &kind);
            BlockDto {
                id: next_id(),
                markdown,
                html,
                kind,
            }
        })
        .collect()
}

#[tauri::command]
pub fn render_block(markdown: String, kind: BlockKind) -> String {
    render_block_html(&markdown, &kind)
}

// Toggle whether disallowed raw HTML is escaped to text when rendering. Pushed
// from the frontend's "Escape unsafe HTML" setting at startup and on change.
#[tauri::command]
pub fn set_escape_unsafe_html(enabled: bool) {
    crate::parser::ESCAPE_UNSAFE_HTML.store(enabled, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskToggle {
    pub markdown: String,
    pub html: String,
}

// Toggle the Nth task-list checkbox in a block and return the updated markdown
// plus its freshly rendered HTML. The parser owns which lines are task items, so
// the frontend only passes the clicked checkbox's index.
#[tauri::command]
pub fn toggle_task(markdown: String, kind: BlockKind, index: usize) -> TaskToggle {
    let markdown = toggle_task_marker(&markdown, index);
    let html = render_block_html(&markdown, &kind);
    TaskToggle { markdown, html }
}

#[tauri::command]
pub async fn open_file(app: tauri::AppHandle) -> Result<Option<FileContent>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    match path {
        Some(fp) => {
            let path_str = fp.to_string();
            let content = read_text(&path_str)?;
            Ok(Some(FileContent {
                path: path_str,
                content,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn notify_settings_changed(app: tauri::AppHandle) {
    let _ = app.emit("settings-changed", ());
}

#[tauri::command]
pub async fn reset_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: 800.0,
            height: 600.0,
        }));
        let _ = w.center();
    }
}

#[tauri::command]
pub async fn open_settings(app: tauri::AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    read_text(&path)
}

// Atomic save: write to a temp file in the same directory, fsync it, then rename
// it over the target. A plain fs::write truncates the file first, so a crash or
// disk-full mid-write would leave the user's document empty or half-written.
// rename within one directory is atomic on the same filesystem, so the target is
// always either the old content or the complete new content - never a stump.
//
// Metadata policy: the rename creates a new inode, so only the file's Unix
// permission bits are preserved (copied from the original below). Extended
// attributes (macOS Finder tags / color labels, xattr), ACLs and ownership are
// NOT guaranteed to survive a save. Preserving those would need extra
// platform-specific work (e.g. the `xattr` crate) and is out of scope today.
fn write_atomic(path: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    // Resolve symlinks first: renaming onto a symlink path would replace the link
    // itself and leave its real target stale. canonicalize yields the real file
    // (and its real directory, so the temp lands on the same filesystem). A path
    // that doesn't exist yet (new file / Save As) can't be resolved - use it as is.
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = resolved.as_path();
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("untitled"));

    // Hidden, unique temp name beside the target (pid + counter keeps concurrent
    // saves from colliding) so the rename stays on the same filesystem.
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(file_name);
    tmp_name.push(format!(".tmp.{}.{}", std::process::id(), n));
    let tmp = dir.join(tmp_name);

    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content)?;
        // File::create gives the temp the default umask mode, so without this a
        // save would reset the document's permissions (e.g. 0640 -> 0644). Carry
        // the original file's mode onto the temp before it takes its place, and
        // do it before sync_all so the flush covers the mode change too. A new
        // file (Save As) has no original mode to copy - it keeps the default. A
        // real failure to apply an existing file's mode is surfaced, not
        // silently swallowed, so a save never quietly changes permissions.
        // Copy the original's mode when it exists. A missing original (new file /
        // Save As) is fine - keep the default. Any OTHER metadata error (e.g. no
        // permission to stat) is surfaced, not swallowed, so a save can't quietly
        // proceed with the wrong mode.
        match std::fs::metadata(path) {
            Ok(meta) => std::fs::set_permissions(&tmp, meta.permissions())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        f.sync_all()?; // flush data + the mode change to disk before the rename
        std::fs::rename(&tmp, path)
    })();
    // On any failure the temp file must not linger; the original is untouched.
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[tauri::command]
pub async fn save_file(path: String, content: String) -> Result<(), String> {
    write_atomic(std::path::Path::new(&path), content.as_bytes()).map_err(|e| e.to_string())
}

// Modification time (ms since epoch) + size of a file. Used to detect that a
// file changed on disk (Git, another editor, sync) between opening and saving,
// so Marku can warn before overwriting external changes. `Ok(None)` means the
// file is gone; a real metadata error (permissions, etc.) is `Err`, never None,
// so the caller can't mistake "couldn't check" for "no change".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSignature {
    pub mtime_ms: u64,
    pub size: u64,
}

#[tauri::command]
pub fn file_signature(path: String) -> Result<Option<FileSignature>, String> {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    // Don't unwrap on odd timestamps: fall back to 0 and rely on size instead.
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(FileSignature {
        mtime_ms,
        size: meta.len(),
    }))
}

// Canonical form of a path (resolves symlinks and, on case-insensitive volumes,
// the real on-disk case) so the frontend can tell whether two tabs point at the
// same file. Falls back to the input when the path can't be resolved.
#[tauri::command]
pub fn canonical_path(path: String) -> String {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

// Show the Save As dialog and return the chosen path WITHOUT writing. The
// frontend checks the path against other open tabs before writing via save_file,
// so a path already open elsewhere can be refused instead of overwritten.
#[tauri::command]
pub async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let name = default_name.unwrap_or_else(|| "untitled.md".to_string());
    let path = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&name)
        .blocking_save_file();
    Ok(path.map(|fp| fp.to_string()))
}
