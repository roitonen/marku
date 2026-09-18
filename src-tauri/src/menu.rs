//! Native application menu (macOS app menu + File/Edit/View) and the Word Wrap
//! check item that the frontend keeps in sync.

use tauri::Manager;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

/// Holds the Word Wrap check menu item so the frontend can keep it in sync.
pub struct WordWrapMenu(std::sync::Mutex<CheckMenuItem<tauri::Wry>>);

#[tauri::command]
pub fn set_word_wrap_menu(state: tauri::State<WordWrapMenu>, checked: bool) {
    if let Ok(item) = state.0.lock() {
        let _ = item.set_checked(checked);
    }
}

/// Enable/disable the Word Wrap menu item from Rust (used while the Settings
/// window owns the setting). Not a Tauri command - called internally.
pub(crate) fn set_word_wrap_menu_enabled(app: &tauri::AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<WordWrapMenu>()
        && let Ok(item) = state.0.lock()
    {
        let _ = item.set_enabled(enabled);
    }
}

/// Build the full application menu and register the Word Wrap item as managed
/// state. The returned menu is handed to `app.set_menu`.
pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    // Custom Quit so Cmd+Q runs our save-unsaved-tabs flow instead of the
    // predefined item, which hard-terminates the app immediately.
    let quit_i = MenuItem::with_id(app, "quit", "Quit Marku", true, Some("CmdOrCtrl+Q"))?;

    // macOS app menu (first item = app name)
    let app_menu = Submenu::with_id_and_items(
        app,
        "app",
        "Marku",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                None,
                Some(
                    tauri::menu::AboutMetadataBuilder::new()
                        .icon(app.default_window_icon().cloned())
                        .build(),
                ),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &settings_i,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_i,
        ],
    )?;

    let new_i = MenuItem::with_id(app, "new", "New Tab", true, Some("CmdOrCtrl+T"))?;
    let open_i = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let open_recent_i = MenuItem::with_id(
        app,
        "open_recent",
        "Open Recent…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let save_i = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as_i = MenuItem::with_id(app, "save_as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?;
    let print_i = MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+P"))?;

    let file_menu = Submenu::with_id_and_items(
        app,
        "file",
        "File",
        true,
        &[
            &new_i,
            &open_i,
            &open_recent_i,
            &PredefinedMenuItem::separator(app)?,
            &save_i,
            &save_as_i,
            &PredefinedMenuItem::separator(app)?,
            &print_i,
        ],
    )?;

    let edit_menu = Submenu::with_id_and_items(
        app,
        "edit",
        "Edit",
        true,
        &[
            // Custom (not PredefinedMenuItem::undo/redo, which drive the native
            // textarea history) so Undo/Redo route through the app's unified
            // history. No accelerator here - Cmd+Z is handled in the webview
            // (preview: our history; Source View: CodeMirror).
            &MenuItem::with_id(app, "undo", "Undo", true, None::<&str>)?,
            &MenuItem::with_id(app, "redo", "Redo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // Format: wrap/unwrap the selection with markdown markers, or make a link.
    // Accelerators live here (native menu) so they fire app-wide; the webview
    // applies the edit via the emitted menu:format event.
    let fmt_bold_i = MenuItem::with_id(app, "format_bold", "Bold", true, Some("CmdOrCtrl+B"))?;
    let fmt_italic_i =
        MenuItem::with_id(app, "format_italic", "Italic", true, Some("CmdOrCtrl+I"))?;
    let fmt_strike_i = MenuItem::with_id(
        app,
        "format_strike",
        "Strikethrough",
        true,
        Some("CmdOrCtrl+Shift+X"),
    )?;
    let fmt_math_i = MenuItem::with_id(
        app,
        "format_math",
        "Display Math",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let fmt_link_i = MenuItem::with_id(app, "format_link", "Link", true, Some("CmdOrCtrl+K"))?;

    let format_menu = Submenu::with_id_and_items(
        app,
        "format",
        "Format",
        true,
        &[
            &fmt_bold_i,
            &fmt_italic_i,
            &fmt_strike_i,
            &PredefinedMenuItem::separator(app)?,
            &fmt_math_i,
            &PredefinedMenuItem::separator(app)?,
            &fmt_link_i,
        ],
    )?;

    let render_i = MenuItem::with_id(app, "render", "Render Preview", true, Some("CmdOrCtrl+R"))?;
    let font_inc_i = MenuItem::with_id(
        app,
        "font_inc",
        "Increase Font Size",
        true,
        Some("CmdOrCtrl+="),
    )?;
    let font_dec_i = MenuItem::with_id(
        app,
        "font_dec",
        "Decrease Font Size",
        true,
        Some("CmdOrCtrl+-"),
    )?;
    let font_reset_i = MenuItem::with_id(
        app,
        "font_reset",
        "Reset Font Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let word_wrap_i = CheckMenuItem::with_id(
        app,
        "word_wrap",
        "Word Wrap",
        true,
        crate::window::word_wrap_enabled(app),
        Some("CmdOrCtrl+."),
    )?;
    app.manage(WordWrapMenu(std::sync::Mutex::new(word_wrap_i.clone())));

    let view_menu = Submenu::with_id_and_items(
        app,
        "view",
        "View",
        true,
        &[
            &render_i,
            &PredefinedMenuItem::separator(app)?,
            &font_inc_i,
            &font_dec_i,
            &font_reset_i,
            &PredefinedMenuItem::separator(app)?,
            &word_wrap_i,
        ],
    )?;

    // Help: each item opens a bundled Markdown doc in a new tab, rendered by the
    // app itself. "Marku Help" gets the macOS-conventional accelerator.
    let help_getting_started_i =
        MenuItem::with_id(app, "help_getting_started", "Marku Help", true, Some("F1"))?;
    let help_shortcuts_i = MenuItem::with_id(
        app,
        "help_shortcuts",
        "Keyboard Shortcuts",
        true,
        Some("CmdOrCtrl+Shift+K"),
    )?;
    let help_markdown_i =
        MenuItem::with_id(app, "help_markdown", "Markdown Guide", true, None::<&str>)?;
    let help_troubleshooting_i = MenuItem::with_id(
        app,
        "help_troubleshooting",
        "Troubleshooting",
        true,
        None::<&str>,
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        "help",
        "Help",
        true,
        &[
            &help_getting_started_i,
            &PredefinedMenuItem::separator(app)?,
            &help_shortcuts_i,
            &help_markdown_i,
            &help_troubleshooting_i,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &format_menu,
            &view_menu,
            &help_menu,
        ],
    )
}
