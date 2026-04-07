use crate::managers::history::{HistoryEntry, HistoryManager};
use crate::settings;
use crate::tray_i18n::get_tray_translations;
use log::{error, info, warn};
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone, Debug, PartialEq)]
pub enum TrayIconState {
    Idle,
    Recording,
    Transcribing,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
    Colored, // Colored theme for Linux
}

/// Gets the current app theme, with Linux defaulting to Colored theme
pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    if cfg!(target_os = "linux") {
        // On Linux, always use the colored theme
        AppTheme::Colored
    } else {
        // On other platforms, map system theme to our app theme
        if let Some(main_window) = app.get_webview_window("main") {
            match main_window.theme().unwrap_or(Theme::Dark) {
                Theme::Light => AppTheme::Light,
                Theme::Dark => AppTheme::Dark,
                _ => AppTheme::Dark, // Default fallback
            }
        } else {
            AppTheme::Dark
        }
    }
}

/// Gets the appropriate icon path for the given theme and state
pub fn get_icon_path(theme: AppTheme, state: TrayIconState) -> &'static str {
    match (theme, state) {
        // Dark theme uses light icons
        (AppTheme::Dark, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Dark, TrayIconState::Recording) => "resources/tray_recording.png",
        (AppTheme::Dark, TrayIconState::Transcribing) => "resources/tray_transcribing.png",
        // Light theme uses dark icons
        (AppTheme::Light, TrayIconState::Idle) => "resources/tray_idle_dark.png",
        (AppTheme::Light, TrayIconState::Recording) => "resources/tray_recording_dark.png",
        (AppTheme::Light, TrayIconState::Transcribing) => "resources/tray_transcribing_dark.png",
        // Colored theme uses colored status icons (for Linux)
        (AppTheme::Colored, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Colored, TrayIconState::Recording) => "resources/recording.png",
        (AppTheme::Colored, TrayIconState::Transcribing) => "resources/transcribing.png",
    }
}

pub fn change_tray_icon(app: &AppHandle, icon: TrayIconState) {
    let tray = app.state::<TrayIcon>();
    let theme = get_current_theme(app);

    let icon_path = get_icon_path(theme, icon.clone());

    let _ = tray.set_icon(Some(
        Image::from_path(
            app.path()
                .resolve(icon_path, tauri::path::BaseDirectory::Resource)
                .expect("failed to resolve"),
        )
        .expect("failed to set icon"),
    ));

    // Update menu based on state
    update_tray_menu(app, &icon, None);
}

pub fn update_tray_menu(app: &AppHandle, state: &TrayIconState, locale: Option<&str>) {
    let settings = settings::get_settings(app);

    let locale = locale.unwrap_or(&settings.app_language);
    let strings = get_tray_translations(Some(locale.to_string()));
    let settings_label = strings
        .settings
        .trim_matches(|c: char| c == '.' || c == '…' || c.is_whitespace());

    // Platform-specific accelerators
    #[cfg(target_os = "macos")]
    let (settings_accelerator, quit_accelerator) = (Some("Cmd+,"), Some("Cmd+Q"));
    #[cfg(not(target_os = "macos"))]
    let (settings_accelerator, quit_accelerator) = (Some("Ctrl+,"), Some("Ctrl+Q"));
    let copy_last_transcript_shortcut = settings
        .bindings
        .get("copy_last_transcript")
        .map(|binding| tray_shortcut_display(&binding.current_binding));

    // Create common menu items
    let version_label = if cfg!(debug_assertions) {
        format!("Uttr v{} (Dev)", env!("CARGO_PKG_VERSION"))
    } else {
        format!("Uttr v{}", env!("CARGO_PKG_VERSION"))
    };
    let version_i = MenuItem::with_id(app, "version", &version_label, false, None::<&str>)
        .expect("failed to create version item");
    let settings_i = MenuItem::with_id(app, "settings", settings_label, true, settings_accelerator)
        .expect("failed to create settings item");
    let check_updates_i = MenuItem::with_id(
        app,
        "check_updates",
        &strings.check_updates,
        settings.update_checks_enabled,
        None::<&str>,
    )
    .expect("failed to create check updates item");
    let copy_last_transcript_label = copy_last_transcript_shortcut.as_ref().map_or_else(
        || strings.copy_last_transcript.clone(),
        |shortcut| {
            if shortcut.show_in_label {
                format!("{} ({})", strings.copy_last_transcript, shortcut.display)
            } else {
                strings.copy_last_transcript.clone()
            }
        },
    );
    let copy_last_transcript_i = MenuItem::with_id(
        app,
        "copy_last_transcript",
        &copy_last_transcript_label,
        true,
        copy_last_transcript_shortcut
            .as_ref()
            .and_then(|shortcut| shortcut.accelerator.as_deref()),
    )
    .expect("failed to create copy last transcript item");
    let quit_i = MenuItem::with_id(app, "quit", &strings.quit, true, quit_accelerator)
        .expect("failed to create quit item");
    let separator = || PredefinedMenuItem::separator(app).expect("failed to create separator");

    let menu = match state {
        TrayIconState::Recording | TrayIconState::Transcribing => {
            let cancel_i = MenuItem::with_id(app, "cancel", &strings.cancel, true, None::<&str>)
                .expect("failed to create cancel item");
            Menu::with_items(
                app,
                &[
                    &version_i,
                    &separator(),
                    &cancel_i,
                    &separator(),
                    &copy_last_transcript_i,
                    &separator(),
                    &settings_i,
                    &check_updates_i,
                    &separator(),
                    &quit_i,
                ],
            )
            .expect("failed to create menu")
        }
        TrayIconState::Idle => Menu::with_items(
            app,
            &[
                &version_i,
                &separator(),
                &copy_last_transcript_i,
                &settings_i,
                &check_updates_i,
                &separator(),
                &quit_i,
            ],
        )
        .expect("failed to create menu"),
    };

    let tray = app.state::<TrayIcon>();
    let _ = tray.set_menu(Some(menu));
    // Keep full-color tray icon for uttr branding in the macOS menu bar.
    let _ = tray.set_icon_as_template(false);
}

fn last_transcript_text(entry: &HistoryEntry) -> &str {
    entry
        .post_processed_text
        .as_deref()
        .unwrap_or(&entry.transcription_text)
}

pub fn set_tray_visibility(app: &AppHandle, visible: bool) {
    let tray = app.state::<TrayIcon>();
    if let Err(e) = tray.set_visible(visible) {
        error!("Failed to set tray visibility: {}", e);
    } else {
        info!("Tray visibility set to: {}", visible);
    }
}

pub fn copy_last_transcript(app: &AppHandle) {
    let history_manager = app.state::<Arc<HistoryManager>>();
    let entry = match history_manager.get_latest_entry() {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            warn!("No transcription history entries available for tray copy.");
            return;
        }
        Err(err) => {
            error!("Failed to fetch last transcription entry: {}", err);
            return;
        }
    };

    if let Err(err) = app.clipboard().write_text(last_transcript_text(&entry)) {
        error!("Failed to copy last transcript to clipboard: {}", err);
        return;
    }

    info!("Copied last transcript to clipboard via tray.");
}

struct TrayShortcutDisplay {
    display: String,
    accelerator: Option<String>,
    show_in_label: bool,
}

fn tray_shortcut_display(binding: &str) -> TrayShortcutDisplay {
    let parts: Vec<String> = binding
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "command" | "cmd" => "Cmd".to_string(),
            "option" | "alt" => "Alt".to_string(),
            "ctrl" | "control" => "Ctrl".to_string(),
            "shift" => "Shift".to_string(),
            "super" | "win" | "windows" | "meta" => "Super".to_string(),
            "fn" => "Fn".to_string(),
            "escape" | "esc" => "Esc".to_string(),
            "space" => "Space".to_string(),
            other if other.len() == 1 => other.to_ascii_uppercase(),
            other => {
                let mut chars = other.chars();
                match chars.next() {
                    Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect();

    let has_non_modifier = binding.split('+').map(str::trim).any(|part| {
        !matches!(
            part.to_ascii_lowercase().as_str(),
            "command"
                | "cmd"
                | "option"
                | "alt"
                | "ctrl"
                | "control"
                | "shift"
                | "super"
                | "win"
                | "windows"
                | "meta"
                | "fn"
        )
    });

    let display = if parts.is_empty() {
        binding.to_string()
    } else {
        parts.join("+")
    };

    TrayShortcutDisplay {
        display: display.clone(),
        accelerator: has_non_modifier.then_some(display),
        show_in_label: !has_non_modifier,
    }
}

#[cfg(test)]
mod tests {
    use super::{last_transcript_text, tray_shortcut_display};
    use crate::managers::history::HistoryEntry;

    fn build_entry(transcription: &str, post_processed: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: 1,
            file_name: "uttr-1.wav".to_string(),
            timestamp: 0,
            saved: false,
            title: "Recording".to_string(),
            transcription_text: transcription.to_string(),
            post_processed_text: post_processed.map(|text| text.to_string()),
            post_process_prompt: None,
        }
    }

    #[test]
    fn uses_post_processed_text_when_available() {
        let entry = build_entry("raw", Some("processed"));
        assert_eq!(last_transcript_text(&entry), "processed");
    }

    #[test]
    fn falls_back_to_raw_transcription() {
        let entry = build_entry("raw", None);
        assert_eq!(last_transcript_text(&entry), "raw");
    }

    #[test]
    fn maps_copy_last_transcript_binding_to_tray_accelerator() {
        let modifier_only = tray_shortcut_display("command+fn");
        assert_eq!(modifier_only.display, "Cmd+Fn");
        assert_eq!(modifier_only.accelerator, None);
        assert!(modifier_only.show_in_label);

        let normal = tray_shortcut_display("ctrl+alt+c");
        assert_eq!(normal.display, "Ctrl+Alt+C");
        assert_eq!(normal.accelerator, Some("Ctrl+Alt+C".to_string()));
        assert!(!normal.show_in_label);
    }
}
