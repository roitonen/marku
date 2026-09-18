//! Window creation helpers and the Settings-window lifecycle.

use tauri::Manager;

/// Whether the user opted into remembering window geometry. Defaults to true
/// when the setting or the store itself is absent.
pub fn remember_window(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    match app.store("settings.json") {
        Ok(store) => match store.get("rememberWindow") {
            Some(v) => v.as_bool().unwrap_or(true),
            None => true,
        },
        Err(_) => true,
    }
}

/// Word-wrap setting as stored; defaults to true when absent, matching the
/// frontend DEFAULT_SETTINGS so the menu checkmark agrees on first launch.
pub fn word_wrap_enabled(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    match app.store("settings.json") {
        Ok(store) => match store.get("wordWrap") {
            Some(v) => v.as_bool().unwrap_or(true),
            None => true,
        },
        Err(_) => true,
    }
}

pub fn show_settings_window(app: &tauri::AppHandle) {
    // Word Wrap also lives in the Settings window; disable the menu item while
    // it's open to avoid two controls fighting over the same setting. Disable
    // only after the window actually shows, so a build failure can't leave the
    // item stuck disabled.
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        crate::menu::set_word_wrap_menu_enabled(app, false);
    } else {
        #[allow(unused_mut)]
        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            "settings",
            tauri::WebviewUrl::App("settings.html".into()),
        )
        .title(if cfg!(target_os = "macos") {
            ""
        } else {
            "Settings"
        })
        .inner_size(520.0, 680.0)
        .resizable(false);
        // Transparent + overlay titlebar is macOS-only; on Windows/Linux use a
        // normal decorated window (matches the main-window branch).
        #[cfg(target_os = "macos")]
        {
            use tauri::TitleBarStyle;
            builder = builder
                .transparent(true)
                .title_bar_style(TitleBarStyle::Overlay);
        }
        if let Ok(w) = builder.build() {
            let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: 520.0,
                height: 680.0,
            }));
            crate::menu::set_word_wrap_menu_enabled(app, false);
            let app_handle = app.clone();
            w.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    crate::menu::set_word_wrap_menu_enabled(&app_handle, true);
                }
            });
        }
    }
}
