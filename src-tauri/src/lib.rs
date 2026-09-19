mod commands;
mod menu;
mod parser;
mod window;

use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};
use window::{remember_window, show_settings_window};

/// Send a formatting command to the main window, but only when it is the focused
/// window - otherwise a native accelerator pressed in Settings would edit the
/// document in the background. emit_to targets main alone (not every webview).
fn emit_format(app: &tauri::AppHandle, kind: &str) {
    if let Some(win) = app.get_webview_window("main")
        && win.is_focused().unwrap_or(false)
    {
        let _ = app.emit_to("main", "menu:format", kind);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .build(),
        )
        .on_window_event(|window, event| {
            // Intercept closing the main window (incl. Cmd+Q on macOS, which
            // sends CloseRequested to the window) so the frontend can prompt
            // to save unsaved tabs first. quit_app sets QUITTING and exits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
                && !commands::QUITTING.load(Ordering::Relaxed)
            {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                let win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("")
                .inner_size(800.0, 600.0)
                .transparent(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .build()?;

                // Window-state plugin skips "main" automatically; restore it
                // manually only when the user opted into remembering geometry.
                if remember_window(app.handle()) {
                    use tauri_plugin_window_state::{StateFlags, WindowExt};
                    let _ = win.restore_state(StateFlags::all());
                }
            }

            // Non-macOS: a plain decorated window (transparent + overlay titlebar
            // are macOS-only). Without this the app would start with no window.
            #[cfg(not(target_os = "macos"))]
            {
                let win = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Marku")
                .inner_size(800.0, 600.0)
                .build()?;

                if remember_window(app.handle()) {
                    use tauri_plugin_window_state::{StateFlags, WindowExt};
                    let _ = win.restore_state(StateFlags::all());
                }
            }

            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new" => {
                let _ = app.emit("menu:new", ());
            }
            // Cmd+Q only quits from the bare main window. If the Settings
            // window is open, ignore it (close Settings with its own controls).
            "quit" => {
                if app.get_webview_window("settings").is_none() {
                    let _ = app.emit("quit-requested", ());
                }
            }
            "font_inc" => {
                let _ = app.emit("menu:font-inc", ());
            }
            "font_dec" => {
                let _ = app.emit("menu:font-dec", ());
            }
            "font_reset" => {
                let _ = app.emit("menu:font-reset", ());
            }
            "word_wrap" => {
                let _ = app.emit("menu:word-wrap", ());
            }
            "open" => {
                let _ = app.emit("menu:open", ());
            }
            "open_recent" => {
                let _ = app.emit("menu:open-recent", ());
            }
            "save" => {
                let _ = app.emit("menu:save", ());
            }
            "save_as" => {
                let _ = app.emit("menu:save-as", ());
            }
            "print" => {
                let _ = app.emit("menu:print", ());
            }
            "render" => {
                let _ = app.emit("menu:render", ());
            }
            "undo" => {
                let _ = app.emit("menu:undo", ());
            }
            "redo" => {
                let _ = app.emit("menu:redo", ());
            }
            "format_bold" => emit_format(app, "bold"),
            "format_italic" => emit_format(app, "italic"),
            "format_strike" => emit_format(app, "strike"),
            "format_math" => emit_format(app, "math"),
            "format_link" => emit_format(app, "link"),
            "settings" => {
                show_settings_window(app);
            }
            "help_getting_started" => {
                let _ = app.emit("menu:help", "getting-started");
            }
            "help_shortcuts" => {
                let _ = app.emit("menu:help", "shortcuts");
            }
            "help_markdown" => {
                let _ = app.emit("menu:help", "markdown");
            }
            "help_troubleshooting" => {
                let _ = app.emit("menu:help", "troubleshooting");
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::parse_document,
            commands::render_block,
            commands::set_escape_unsafe_html,
            commands::toggle_task,
            commands::open_file,
            commands::read_file,
            commands::save_file,
            commands::file_signature,
            commands::pick_save_path,
            commands::canonical_path,
            commands::open_settings,
            commands::notify_settings_changed,
            commands::reset_main_window,
            menu::set_word_wrap_menu,
            commands::quit_app,
            commands::take_opened_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Intercept quit (Cmd+Q): let the frontend prompt to save unsaved
            // tabs first. quit_app sets QUITTING and re-triggers the exit.
            tauri::RunEvent::ExitRequested { api, .. }
                if !commands::QUITTING.load(Ordering::Relaxed) =>
            {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
            }
            // Finder double-click / Open With. The path is stored first because on
            // a cold start this fires before the frontend listens; the event only
            // tells an already running frontend to drain the list.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned());
                commands::PENDING_OPENS.lock().unwrap().extend(paths);
                let _ = app.emit_to("main", "opened", ());
            }
            _ => {}
        });
}
