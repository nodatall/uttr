use crate::settings;
use crate::settings::OverlayPosition;
use log::debug;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use tauri::{PhysicalPosition, PhysicalSize};

#[cfg(not(target_os = "macos"))]
use tauri::WebviewWindowBuilder;

#[cfg(target_os = "macos")]
use tauri::WebviewUrl;

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt as _, PanelBuilder, PanelLevel};

#[cfg(target_os = "linux")]
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
#[cfg(target_os = "linux")]
use std::env;

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(RecordingOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

const OVERLAY_WIDTH: f64 = 172.0;
const OVERLAY_HEIGHT: f64 = 42.0;
const OVERLAY_ALERT_WIDTH: f64 = 260.0;
const OVERLAY_ALERT_HEIGHT: f64 = 72.0;
const OVERLAY_PROGRESS_WIDTH: f64 = 520.0;
const OVERLAY_PROGRESS_HEIGHT: f64 = 272.0;
const OVERLAY_LABEL_BASE: &str = "recording_overlay";
static OVERLAY_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullSystemProgressPayload {
    pub stage: String,
    pub title: String,
    pub subtitle: String,
    pub progress_label: String,
    pub progress_value: f32,
    pub footer_note: String,
    pub transcript_text: Option<String>,
    pub history_entry_id: Option<i64>,
}

#[cfg(target_os = "macos")]
const OVERLAY_TOP_OFFSET: f64 = 46.0;
#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_TOP_OFFSET: f64 = 4.0;

#[cfg(target_os = "macos")]
const OVERLAY_BOTTOM_OFFSET: f64 = 10.0;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_BOTTOM_OFFSET: f64 = 35.0;

#[cfg(target_os = "linux")]
fn update_gtk_layer_shell_anchors(overlay_window: &tauri::webview::WebviewWindow) {
    let window_clone = overlay_window.clone();
    let _ = overlay_window.run_on_main_thread(move || {
        // Try to get the GTK window from the Tauri webview
        if let Ok(gtk_window) = window_clone.gtk_window() {
            let settings = settings::get_settings(window_clone.app_handle());
            match settings.overlay_position {
                OverlayPosition::Top => {
                    gtk_window.set_anchor(Edge::Top, true);
                    gtk_window.set_anchor(Edge::Bottom, false);
                }
                OverlayPosition::Bottom | OverlayPosition::None => {
                    gtk_window.set_anchor(Edge::Bottom, true);
                    gtk_window.set_anchor(Edge::Top, false);
                }
            }
        }
    });
}

/// Initializes GTK layer shell for Linux overlay window
/// Returns true if layer shell was successfully initialized, false otherwise
#[cfg(target_os = "linux")]
fn init_gtk_layer_shell(overlay_window: &tauri::webview::WebviewWindow) -> bool {
    // On KDE Wayland, layer-shell init has shown protocol instability.
    // Fall back to regular always-on-top overlay behavior (as in v0.7.1).
    let is_wayland = env::var("WAYLAND_DISPLAY").is_ok()
        || env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    let is_kde = env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.to_uppercase().contains("KDE"))
        .unwrap_or(false)
        || env::var("KDE_SESSION_VERSION").is_ok();
    if is_wayland && is_kde {
        debug!("Skipping GTK layer shell init on KDE Wayland");
        return false;
    }

    if !gtk_layer_shell::is_supported() {
        return false;
    }

    // Try to get the GTK window from the Tauri webview
    if let Ok(gtk_window) = overlay_window.gtk_window() {
        // Initialize layer shell
        gtk_window.init_layer_shell();
        gtk_window.set_layer(Layer::Overlay);
        gtk_window.set_keyboard_mode(KeyboardMode::None);
        gtk_window.set_exclusive_zone(0);

        update_gtk_layer_shell_anchors(overlay_window);

        return true;
    }
    false
}

/// Forces a window to be topmost using Win32 API (Windows only)
/// This is more reliable than Tauri's set_always_on_top which can be overridden
#[cfg(target_os = "windows")]
fn force_overlay_topmost(overlay_window: &tauri::webview::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    // Clone because run_on_main_thread takes 'static
    let overlay_clone = overlay_window.clone();

    // Make sure the Win32 call happens on the UI thread
    let _ = overlay_clone.clone().run_on_main_thread(move || {
        if let Ok(hwnd) = overlay_clone.hwnd() {
            unsafe {
                // Force Z-order: make this window topmost without changing size/pos or stealing focus
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn calculate_overlay_position_for_monitor(
    app_handle: &AppHandle,
    monitor: &tauri::Monitor,
    overlay_width: f64,
    overlay_height: f64,
) -> (f64, f64, f64) {
    let scale = monitor.scale_factor();
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();

    let monitor_x = monitor_pos.x as f64;
    let monitor_y = monitor_pos.y as f64;
    let monitor_width = monitor_size.width as f64;
    let monitor_height = monitor_size.height as f64;

    let overlay_width = overlay_width * scale;
    let overlay_height = overlay_height * scale;

    let top_offset = OVERLAY_TOP_OFFSET * scale;
    let bottom_offset = OVERLAY_BOTTOM_OFFSET * scale;

    let settings = settings::get_settings(app_handle);

    let x = monitor_x + (monitor_width - overlay_width) / 2.0;
    let y = match settings.overlay_position {
        OverlayPosition::Top => monitor_y + top_offset,
        OverlayPosition::Bottom | OverlayPosition::None => {
            monitor_y + monitor_height - overlay_height - bottom_offset
        }
    };

    (x, y, scale)
}

fn get_monitor_with_cursor(app_handle: &AppHandle) -> Option<tauri::Monitor> {
    if let Ok(mouse_position) = app_handle.cursor_position() {
        let mouse_location = (mouse_position.x, mouse_position.y);
        if let Ok(monitors) = app_handle.available_monitors() {
            for monitor in monitors {
                let is_within =
                    is_mouse_within_monitor(mouse_location, monitor.position(), monitor.size());
                if is_within {
                    return Some(monitor);
                }
            }
        }
    }

    app_handle.primary_monitor().ok().flatten()
}

fn is_mouse_within_monitor(
    mouse_pos: (f64, f64),
    monitor_pos: &PhysicalPosition<i32>,
    monitor_size: &PhysicalSize<u32>,
) -> bool {
    let (mouse_x, mouse_y) = mouse_pos;
    let PhysicalPosition {
        x: monitor_x,
        y: monitor_y,
    } = *monitor_pos;
    let PhysicalSize {
        width: monitor_width,
        height: monitor_height,
    } = *monitor_size;

    mouse_x >= monitor_x as f64
        && mouse_x < (monitor_x + monitor_width as i32) as f64
        && mouse_y >= monitor_y as f64
        && mouse_y < (monitor_y + monitor_height as i32) as f64
}

#[cfg(not(target_os = "macos"))]
fn calculate_overlay_position(
    app_handle: &AppHandle,
    overlay_width: f64,
    overlay_height: f64,
) -> Option<(f64, f64)> {
    if let Some(monitor) = get_monitor_with_cursor(app_handle) {
        let work_area = monitor.work_area();
        let scale = monitor.scale_factor();
        let work_area_width = work_area.size.width as f64 / scale;
        let work_area_height = work_area.size.height as f64 / scale;
        let work_area_x = work_area.position.x as f64 / scale;
        let work_area_y = work_area.position.y as f64 / scale;

        let settings = settings::get_settings(app_handle);

        let x = work_area_x + (work_area_width - overlay_width) / 2.0;
        let y = match settings.overlay_position {
            OverlayPosition::Top => work_area_y + OVERLAY_TOP_OFFSET,
            OverlayPosition::Bottom | OverlayPosition::None => {
                work_area_y + work_area_height - overlay_height - OVERLAY_BOTTOM_OFFSET
            }
        };

        return Some((x, y));
    }
    None
}

/// Creates the recording overlay window and keeps it hidden by default
#[cfg(target_os = "macos")]
pub fn create_recording_overlay(app_handle: &AppHandle) {
    if app_handle.get_webview_window(OVERLAY_LABEL_BASE).is_some() {
        return;
    }

    let Some(monitor) =
        get_monitor_with_cursor(app_handle).or_else(|| app_handle.primary_monitor().ok().flatten())
    else {
        debug!("Failed to determine monitor for overlay, not creating overlay window");
        return;
    };

    let (x, y, scale) =
        calculate_overlay_position_for_monitor(app_handle, &monitor, OVERLAY_WIDTH, OVERLAY_HEIGHT);
    debug!(
        "[overlay] macos create label={} target_pos=({:.1}, {:.1}) scale={}",
        OVERLAY_LABEL_BASE, x, y, scale
    );
    match PanelBuilder::<_, RecordingOverlayPanel>::new(app_handle, OVERLAY_LABEL_BASE)
        .url(WebviewUrl::App("src/overlay/index.html".into()))
        .title("Recording")
        .position(tauri::Position::Logical(tauri::LogicalPosition {
            x: x / scale,
            y: y / scale,
        }))
        .level(PanelLevel::Status)
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: OVERLAY_WIDTH,
            height: OVERLAY_HEIGHT,
        }))
        .has_shadow(false)
        .transparent(true)
        .hides_on_deactivate(false)
        .no_activate(true)
        .corner_radius(0.0)
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => {
            let _ = panel.hide();
            debug!(
                "[overlay] macos created label={} (hidden)",
                OVERLAY_LABEL_BASE
            );
        }
        Err(e) => {
            debug!(
                "Failed to create macOS overlay panel {}: {}",
                OVERLAY_LABEL_BASE, e
            );
        }
    }
}

/// Creates the recording overlay window and keeps it hidden by default
#[cfg(not(target_os = "macos"))]
pub fn create_recording_overlay(app_handle: &AppHandle) {
    let position = calculate_overlay_position(app_handle, OVERLAY_WIDTH, OVERLAY_HEIGHT);

    // On Linux (Wayland), monitor detection often fails, but we don't need exact coordinates
    // for Layer Shell as we use anchors. On other platforms, we require a position.
    #[cfg(not(target_os = "linux"))]
    if position.is_none() {
        debug!("Failed to determine overlay position, not creating overlay window");
        return;
    }

    let mut builder = WebviewWindowBuilder::new(
        app_handle,
        OVERLAY_LABEL_BASE,
        tauri::WebviewUrl::App("src/overlay/index.html".into()),
    )
    .title("Recording")
    .resizable(false)
    .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .focused(false)
    .visible(false);

    if let Some((x, y)) = position {
        builder = builder.position(x, y);
    }

    match builder.build() {
        Ok(window) => {
            #[cfg(target_os = "linux")]
            {
                // Try to initialize GTK layer shell, ignore errors if compositor doesn't support it
                if init_gtk_layer_shell(&window) {
                    debug!("GTK layer shell initialized for overlay window");
                } else {
                    debug!("GTK layer shell not available, falling back to regular window");
                }
            }

            debug!("Recording overlay window created successfully (hidden)");
        }
        Err(e) => {
            debug!("Failed to create recording overlay window: {}", e);
        }
    }
}

fn apply_overlay_dimensions(app_handle: &AppHandle, width: f64, height: f64) {
    #[cfg(target_os = "macos")]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let Some(monitor) = get_monitor_with_cursor(app_handle)
                .or_else(|| app_handle.primary_monitor().ok().flatten())
            else {
                return;
            };
            let (x, y, scale) =
                calculate_overlay_position_for_monitor(app_handle, &monitor, width, height);
            let _ =
                overlay_window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
            let _ = overlay_window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: x / scale,
                y: y / scale,
            }));
        }
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ =
                overlay_window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));

            #[cfg(target_os = "linux")]
            {
                update_gtk_layer_shell_anchors(&overlay_window);
            }

            if let Some((x, y)) = calculate_overlay_position(app_handle, width, height) {
                let _ = overlay_window
                    .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            }
        }
    }
}

fn show_overlay_state(app_handle: &AppHandle, state: &str, width: f64, height: f64) {
    let show_start = std::time::Instant::now();
    log::info!("[latency] overlay show requested state={}", state);

    // Check if overlay should be shown based on position setting
    let settings = settings::get_settings(app_handle);
    if settings.overlay_position == OverlayPosition::None {
        log::info!(
            "[latency] overlay show skipped state={} reason=disabled elapsed_ms={}",
            state,
            show_start.elapsed().as_millis()
        );
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        create_recording_overlay(app_handle);
        apply_overlay_dimensions(app_handle, width, height);
    }

    #[cfg(target_os = "macos")]
    {
        let app_for_show = app_handle.clone();
        let state_for_show = state.to_string();
        let state_for_retry = state_for_show.clone();
        std::thread::spawn(move || {
            let app = app_for_show.clone();
            let _ = app_for_show.run_on_main_thread(move || {
                debug!("[overlay] macos show_overlay_state state={}", state_for_show);
                create_recording_overlay(&app);
                apply_overlay_dimensions(&app, width, height);
                if let Some(overlay_window) = app.get_webview_window(OVERLAY_LABEL_BASE) {
                    let _ = overlay_window.show();
                    if let Ok(panel) = app.get_webview_panel(OVERLAY_LABEL_BASE) {
                        panel.order_front_regardless();
                    }
                    let _ = overlay_window.emit("show-overlay", &state_for_show);
                    log::info!(
                        "[latency] overlay shown state={} elapsed_ms={}",
                        state_for_show,
                        show_start.elapsed().as_millis()
                    );
                }
            });

            std::thread::sleep(std::time::Duration::from_millis(90));
            if let Some(window) = app_for_show.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = window.emit("show-overlay", &state_for_retry);
            }
            std::thread::sleep(std::time::Duration::from_millis(180));
            if let Some(window) = app_for_show.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = window.emit("show-overlay", &state_for_retry);
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ = overlay_window.show();

            // On Windows, aggressively re-assert "topmost" in the native Z-order after showing
            #[cfg(target_os = "windows")]
            force_overlay_topmost(&overlay_window);

            let _ = overlay_window.emit("show-overlay", state);
            log::info!(
                "[latency] overlay shown state={} elapsed_ms={}",
                state,
                show_start.elapsed().as_millis()
            );
        }
    }
}

/// Shows the recording overlay window with fade-in animation
pub fn show_recording_overlay(app_handle: &AppHandle) {
    OVERLAY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
    show_overlay_state(app_handle, "recording", OVERLAY_WIDTH, OVERLAY_HEIGHT);
}

pub fn show_warming_overlay(app_handle: &AppHandle) {
    OVERLAY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
    show_overlay_state(app_handle, "warming", OVERLAY_WIDTH, OVERLAY_HEIGHT);
}

/// Shows the transcribing overlay window
pub fn show_transcribing_overlay(app_handle: &AppHandle) {
    show_overlay_state(app_handle, "transcribing", OVERLAY_WIDTH, OVERLAY_HEIGHT);
}

/// Shows the processing overlay window
pub fn show_processing_overlay(app_handle: &AppHandle) {
    show_overlay_state(app_handle, "processing", OVERLAY_WIDTH, OVERLAY_HEIGHT);
}

fn emit_full_system_progress_payload(
    app_handle: &AppHandle,
    payload: &FullSystemProgressPayload,
) {
    #[cfg(target_os = "macos")]
    {
        let payload = payload.clone();
        let payload_for_retry = payload.clone();
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if let Some(overlay_window) = app.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = overlay_window.emit("overlay-full-system-progress", &payload);
            }
        });

        let app_retry = app_handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(90));
            if let Some(window) = app_retry.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = window.emit("overlay-full-system-progress", &payload_for_retry);
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ = overlay_window.emit("overlay-full-system-progress", payload);
        }
    }
}

pub fn show_full_system_progress_overlay(
    app_handle: &AppHandle,
    payload: &FullSystemProgressPayload,
) {
    show_overlay_state(
        app_handle,
        "full_system_progress",
        OVERLAY_PROGRESS_WIDTH,
        OVERLAY_PROGRESS_HEIGHT,
    );
    emit_full_system_progress_payload(app_handle, payload);
}

pub fn update_full_system_progress_overlay(
    app_handle: &AppHandle,
    payload: &FullSystemProgressPayload,
) {
    apply_overlay_dimensions(app_handle, OVERLAY_PROGRESS_WIDTH, OVERLAY_PROGRESS_HEIGHT);
    emit_full_system_progress_payload(app_handle, payload);
}

pub fn emit_overlay_alert(app_handle: &AppHandle, kind: &str) {
    apply_overlay_dimensions(app_handle, OVERLAY_ALERT_WIDTH, OVERLAY_ALERT_HEIGHT);
    #[cfg(target_os = "macos")]
    {
        let kind = kind.to_string();
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if let Some(overlay_window) = app.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = overlay_window.emit("overlay-alert", &kind);
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ = overlay_window.emit("overlay-alert", kind.to_string());
        }
    }
}

/// Updates the overlay window position based on current settings
pub fn update_overlay_position(app_handle: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let Some(monitor) = get_monitor_with_cursor(app_handle)
                .or_else(|| app_handle.primary_monitor().ok().flatten())
            else {
                return;
            };
            let (x, y, scale) = calculate_overlay_position_for_monitor(
                app_handle,
                &monitor,
                OVERLAY_WIDTH,
                OVERLAY_HEIGHT,
            );
            let _ = overlay_window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: x / scale,
                y: y / scale,
            }));
        }
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            #[cfg(target_os = "linux")]
            {
                update_gtk_layer_shell_anchors(&overlay_window);
            }

            if let Some((x, y)) =
                calculate_overlay_position(app_handle, OVERLAY_WIDTH, OVERLAY_HEIGHT)
            {
                let _ = overlay_window
                    .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
            }
        }
    }
}

/// Hides the recording overlay window with fade-out animation
pub fn hide_recording_overlay(app_handle: &AppHandle) {
    let hide_epoch = OVERLAY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    #[cfg(target_os = "macos")]
    {
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if let Some(overlay_window) = app.get_webview_window(OVERLAY_LABEL_BASE) {
                let _ = overlay_window.emit("hide-overlay", ());
                let window_clone = overlay_window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    if OVERLAY_SESSION_EPOCH.load(Ordering::Relaxed) == hide_epoch {
                        let _ = window_clone.hide();
                    }
                });
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            // Emit event to trigger fade-out animation
            let _ = overlay_window.emit("hide-overlay", ());
            // Hide the window after a short delay to allow animation to complete
            let window_clone = overlay_window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(300));
                if OVERLAY_SESSION_EPOCH.load(Ordering::Relaxed) == hide_epoch {
                    let _ = window_clone.hide();
                }
            });
        }
    }
}

pub fn current_overlay_session_epoch() -> u64 {
    OVERLAY_SESSION_EPOCH.load(Ordering::Relaxed)
}

pub fn emit_levels(app_handle: &AppHandle, levels: &Vec<f32>) {
    // emit levels to main app
    let _ = app_handle.emit("mic-level", levels);

    #[cfg(target_os = "macos")]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ = overlay_window.emit("mic-level", levels);
        }
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        // also emit to the recording overlay if it's open
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            let _ = overlay_window.emit("mic-level", levels);
        }
    }
}
