use crate::settings;
use crate::settings::OverlayPosition;
use log::debug;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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

    panel!(AskSelectionPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

const OVERLAY_WIDTH: f64 = 172.0;
const OVERLAY_HEIGHT: f64 = 42.0;
const OVERLAY_ALERT_WIDTH: f64 = 260.0;
const OVERLAY_ALERT_HEIGHT: f64 = 72.0;
const OVERLAY_LABEL_BASE: &str = "recording_overlay";
const ASK_SELECTION_LABEL: &str = "ask_selection_panel";
const ASK_SELECTION_WIDTH: f64 = 760.0;
const ASK_SELECTION_HEIGHT: f64 = 520.0;
const ASK_SELECTION_CURSOR_OFFSET: f64 = 18.0;
const ASK_SELECTION_SCREEN_MARGIN: f64 = 14.0;
static OVERLAY_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);
static ASK_SELECTION_SESSION_EPOCH: AtomicU64 = AtomicU64::new(1);
static ASK_SELECTION_LAST_PAYLOAD: Mutex<Option<AskSelectionPayload>> = Mutex::new(None);

#[derive(Clone, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskSelectionMessage {
    pub role: String,
    pub text: String,
    pub pending: bool,
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AskSelectionPayload {
    pub state: String,
    pub text: Option<String>,
    pub error: Option<String>,
    pub session_id: Option<u64>,
    pub messages: Vec<AskSelectionMessage>,
}

#[cfg(target_os = "macos")]
const OVERLAY_TOP_OFFSET: f64 = 46.0;
#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_TOP_OFFSET: f64 = 4.0;

#[cfg(target_os = "macos")]
const OVERLAY_BOTTOM_OFFSET: f64 = 10.0;

#[cfg(any(target_os = "windows", target_os = "linux"))]
const OVERLAY_BOTTOM_OFFSET: f64 = 35.0;

#[derive(Clone, Copy, Debug)]
struct OverlayBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn calculate_overlay_position_in_bounds(
    monitor_bounds: OverlayBounds,
    work_area_bounds: OverlayBounds,
    scale: f64,
    overlay_width: f64,
    overlay_height: f64,
    overlay_position: OverlayPosition,
) -> (f64, f64) {
    let work_area_bounds = clamp_bounds_to_monitor(work_area_bounds, monitor_bounds);
    let overlay_width = overlay_width * scale;
    let overlay_height = overlay_height * scale;
    let top_offset = OVERLAY_TOP_OFFSET * scale;
    let bottom_offset = OVERLAY_BOTTOM_OFFSET * scale;

    let x = work_area_bounds.x + (work_area_bounds.width - overlay_width) / 2.0;
    let y = match overlay_position {
        OverlayPosition::Top => monitor_bounds.y + top_offset,
        OverlayPosition::Bottom | OverlayPosition::None => {
            work_area_bounds.y + work_area_bounds.height - overlay_height - bottom_offset
        }
    };

    (x, y)
}

fn clamp_bounds_to_monitor(bounds: OverlayBounds, monitor_bounds: OverlayBounds) -> OverlayBounds {
    let x1 = bounds.x.max(monitor_bounds.x);
    let y1 = bounds.y.max(monitor_bounds.y);
    let x2 = (bounds.x + bounds.width).min(monitor_bounds.x + monitor_bounds.width);
    let y2 = (bounds.y + bounds.height).min(monitor_bounds.y + monitor_bounds.height);

    if x2 <= x1 || y2 <= y1 {
        return monitor_bounds;
    }

    OverlayBounds {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
    }
}

fn calculate_cursor_relative_panel_position_in_bounds(
    cursor_x: f64,
    cursor_y: f64,
    work_area_bounds: OverlayBounds,
    panel_width: f64,
    panel_height: f64,
    offset: f64,
    margin: f64,
) -> (f64, f64) {
    let min_x = work_area_bounds.x + margin;
    let min_y = work_area_bounds.y + margin;
    let max_x = (work_area_bounds.x + work_area_bounds.width - panel_width - margin).max(min_x);
    let max_y = (work_area_bounds.y + work_area_bounds.height - panel_height - margin).max(min_y);

    let preferred_x = cursor_x + offset;
    let preferred_y = cursor_y + offset;
    let fallback_x = cursor_x - panel_width - offset;
    let fallback_y = cursor_y - panel_height - offset;

    let x = if preferred_x <= max_x {
        preferred_x
    } else {
        fallback_x
    };
    let y = if preferred_y <= max_y {
        preferred_y
    } else {
        fallback_y
    };

    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn calculate_ask_selection_position(app_handle: &AppHandle) -> Option<(f64, f64)> {
    let monitor = get_monitor_with_cursor(app_handle)
        .or_else(|| app_handle.primary_monitor().ok().flatten())?;
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let cursor = app_handle.cursor_position().ok();
    let cursor_x = cursor
        .map(|position| position.x)
        .unwrap_or_else(|| (work_area.position.x as f64 / scale) + 64.0);
    let cursor_y = cursor
        .map(|position| position.y)
        .unwrap_or_else(|| (work_area.position.y as f64 / scale) + 64.0);
    let work_area_bounds = OverlayBounds {
        x: work_area.position.x as f64 / scale,
        y: work_area.position.y as f64 / scale,
        width: work_area.size.width as f64 / scale,
        height: work_area.size.height as f64 / scale,
    };

    Some(calculate_cursor_relative_panel_position_in_bounds(
        cursor_x,
        cursor_y,
        work_area_bounds,
        ASK_SELECTION_WIDTH,
        ASK_SELECTION_HEIGHT,
        ASK_SELECTION_CURSOR_OFFSET,
        ASK_SELECTION_SCREEN_MARGIN,
    ))
}

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
    let work_area = monitor.work_area();

    let monitor_bounds = OverlayBounds {
        x: monitor_pos.x as f64,
        y: monitor_pos.y as f64,
        width: monitor_size.width as f64,
        height: monitor_size.height as f64,
    };
    let work_area_bounds = OverlayBounds {
        x: work_area.position.x as f64,
        y: work_area.position.y as f64,
        width: work_area.size.width as f64,
        height: work_area.size.height as f64,
    };

    let settings = settings::get_settings(app_handle);
    let (x, y) = calculate_overlay_position_in_bounds(
        monitor_bounds,
        work_area_bounds,
        scale,
        overlay_width,
        overlay_height,
        settings.overlay_position,
    );

    (x, y, scale)
}

fn get_monitor_with_cursor(app_handle: &AppHandle) -> Option<tauri::Monitor> {
    if std::env::var("UTTR_RELEASE_SMOKE")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        return app_handle.primary_monitor().ok().flatten();
    }

    if let Ok(mouse_position) = app_handle.cursor_position() {
        let mouse_location = (mouse_position.x, mouse_position.y);
        if let Ok(monitors) = app_handle.available_monitors() {
            for monitor in monitors {
                let is_within = is_mouse_within_monitor(
                    mouse_location,
                    monitor.position(),
                    monitor.size(),
                    monitor.scale_factor(),
                );
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
    scale: f64,
) -> bool {
    let (mouse_x, mouse_y) = (mouse_pos.0 * scale, mouse_pos.1 * scale);
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
        .movable_by_window_background(true)
        .hides_on_deactivate(false)
        .no_activate(true)
        .corner_radius(0.0)
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .accept_first_mouse(true)
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

fn apply_overlay_z_order_for_state(overlay_window: &tauri::webview::WebviewWindow, _state: &str) {
    let should_float = true;

    #[cfg(target_os = "macos")]
    {
        let _ = overlay_window.set_always_on_top(should_float);
        if let Ok(panel) = overlay_window
            .app_handle()
            .get_webview_panel(OVERLAY_LABEL_BASE)
        {
            let level = if should_float {
                PanelLevel::Status
            } else {
                PanelLevel::Normal
            };
            panel.set_level(level.value());
        }
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = overlay_window.set_always_on_top(should_float);
    }
}

fn overlay_session_epoch_is_current(epoch: u64) -> bool {
    OVERLAY_SESSION_EPOCH.load(Ordering::Relaxed) == epoch
}

fn show_overlay_state(app_handle: &AppHandle, state: &str, width: f64, height: f64) {
    let show_start = std::time::Instant::now();
    let show_epoch = current_overlay_session_epoch();
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
            let epoch_for_show = show_epoch;
            let _ = app_for_show.run_on_main_thread(move || {
                if !overlay_session_epoch_is_current(epoch_for_show) {
                    debug!(
                        "[overlay] skipping stale macos show_overlay_state state={}",
                        state_for_show
                    );
                    return;
                }
                debug!(
                    "[overlay] macos show_overlay_state state={}",
                    state_for_show
                );
                create_recording_overlay(&app);
                apply_overlay_dimensions(&app, width, height);
                if let Some(overlay_window) = app.get_webview_window(OVERLAY_LABEL_BASE) {
                    apply_overlay_z_order_for_state(&overlay_window, &state_for_show);
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
            if overlay_session_epoch_is_current(show_epoch) {
                if let Some(window) = app_for_show.get_webview_window(OVERLAY_LABEL_BASE) {
                    let _ = window.emit("show-overlay", &state_for_retry);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(180));
            if overlay_session_epoch_is_current(show_epoch) {
                if let Some(window) = app_for_show.get_webview_window(OVERLAY_LABEL_BASE) {
                    let _ = window.emit("show-overlay", &state_for_retry);
                }
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(overlay_window) = app_handle.get_webview_window(OVERLAY_LABEL_BASE) {
            apply_overlay_z_order_for_state(&overlay_window, state);
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

pub fn show_trial_ended_overlay(app_handle: &AppHandle) {
    OVERLAY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
    show_overlay_state(app_handle, "trial_ended", OVERLAY_WIDTH, OVERLAY_HEIGHT);
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

pub fn emit_overlay_alert(app_handle: &AppHandle, kind: &str) {
    apply_overlay_dimensions(app_handle, OVERLAY_ALERT_WIDTH, OVERLAY_ALERT_HEIGHT);
    #[cfg(target_os = "macos")]
    {
        let emit_epoch = current_overlay_session_epoch();
        let kind = kind.to_string();
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if !overlay_session_epoch_is_current(emit_epoch) {
                return;
            }
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

#[cfg(target_os = "macos")]
fn create_ask_selection_panel(app_handle: &AppHandle) {
    if app_handle.get_webview_window(ASK_SELECTION_LABEL).is_some() {
        return;
    }

    let (x, y) = calculate_ask_selection_position(app_handle).unwrap_or((64.0, 64.0));
    match PanelBuilder::<_, AskSelectionPanel>::new(app_handle, ASK_SELECTION_LABEL)
        .url(WebviewUrl::App("src/ask-selection/index.html".into()))
        .title("Ask Selection")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .level(PanelLevel::Status)
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: ASK_SELECTION_WIDTH,
            height: ASK_SELECTION_HEIGHT,
        }))
        .has_shadow(true)
        .transparent(true)
        .movable_by_window_background(true)
        .hides_on_deactivate(false)
        .no_activate(false)
        .corner_radius(0.0)
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .always_on_top(true)
                .visible_on_all_workspaces(false)
                .skip_taskbar(true)
                .accept_first_mouse(true)
        })
        .collection_behavior(CollectionBehavior::new().full_screen_auxiliary())
        .build()
    {
        Ok(_) => {
            debug!("[overlay] macos created label={}", ASK_SELECTION_LABEL);
        }
        Err(error) => {
            debug!(
                "Failed to create macOS ask-selection panel {}: {}",
                ASK_SELECTION_LABEL, error
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn create_ask_selection_panel(app_handle: &AppHandle) {
    if app_handle.get_webview_window(ASK_SELECTION_LABEL).is_some() {
        return;
    }

    let (x, y) = calculate_ask_selection_position(app_handle).unwrap_or((64.0, 64.0));
    match WebviewWindowBuilder::new(
        app_handle,
        ASK_SELECTION_LABEL,
        tauri::WebviewUrl::App("src/ask-selection/index.html".into()),
    )
    .title("Ask Selection")
    .resizable(false)
    .inner_size(ASK_SELECTION_WIDTH, ASK_SELECTION_HEIGHT)
    .shadow(true)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .accept_first_mouse(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .focused(true)
    .visible(false)
    .position(x, y)
    .build()
    {
        Ok(_) => debug!("Ask Selection panel created successfully (hidden)"),
        Err(error) => debug!("Failed to create Ask Selection panel: {}", error),
    }
}

pub fn show_ask_selection_panel(app_handle: &AppHandle, payload: AskSelectionPayload) {
    let show_epoch = ASK_SELECTION_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    store_ask_selection_payload(&payload);
    debug!(
        "[overlay] ask selection show requested state={} epoch={}",
        payload.state, show_epoch
    );

    #[cfg(target_os = "macos")]
    {
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            create_ask_selection_panel(&app);
            show_ask_selection_panel_inner(&app, payload, show_epoch);
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        create_ask_selection_panel(app_handle);
        show_ask_selection_panel_inner(app_handle, payload, show_epoch);
    }
}

fn show_ask_selection_panel_inner(
    app_handle: &AppHandle,
    payload: AskSelectionPayload,
    show_epoch: u64,
) {
    let position = calculate_ask_selection_position(app_handle);
    let _ = show_ask_selection_panel_window(app_handle, payload.clone(), position, show_epoch);
    schedule_ask_selection_show_retries(app_handle.clone(), payload, position, show_epoch);
}

fn show_ask_selection_panel_window(
    app_handle: &AppHandle,
    payload: AskSelectionPayload,
    position: Option<(f64, f64)>,
    show_epoch: u64,
) -> bool {
    if let Some(panel_window) = app_handle.get_webview_window(ASK_SELECTION_LABEL) {
        if let Some((x, y)) = position {
            let _ = panel_window
                .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
        }
        let _ = panel_window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: ASK_SELECTION_WIDTH,
            height: ASK_SELECTION_HEIGHT,
        }));
        let _ = panel_window.emit("ask-selection-state", payload.clone());
        let _ = panel_window.show();

        #[cfg(target_os = "macos")]
        if let Ok(panel) = app_handle.get_webview_panel(ASK_SELECTION_LABEL) {
            panel.set_level(PanelLevel::Status.value());
            panel.order_front_regardless();
        }
        let _ = panel_window.set_focus();
        hide_main_window_for_ask_selection(app_handle);
        debug!(
            "[overlay] ask selection shown state={} epoch={}",
            payload.state, show_epoch
        );

        schedule_ask_selection_state_retries(panel_window, payload, show_epoch);
        true
    } else {
        false
    }
}

pub fn update_ask_selection_panel(app_handle: &AppHandle, payload: AskSelectionPayload) {
    let show_epoch = ASK_SELECTION_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    store_ask_selection_payload(&payload);

    #[cfg(target_os = "macos")]
    {
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            update_ask_selection_panel_inner(&app, payload, show_epoch);
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        update_ask_selection_panel_inner(app_handle, payload, show_epoch);
    }
}

fn update_ask_selection_panel_inner(
    app_handle: &AppHandle,
    payload: AskSelectionPayload,
    show_epoch: u64,
) {
    if let Some(panel_window) = app_handle.get_webview_window(ASK_SELECTION_LABEL) {
        let _ = panel_window.emit("ask-selection-state", payload.clone());
        let _ = panel_window.show();

        #[cfg(target_os = "macos")]
        if let Ok(panel) = app_handle.get_webview_panel(ASK_SELECTION_LABEL) {
            panel.set_level(PanelLevel::Status.value());
            panel.order_front_regardless();
        }
        let _ = panel_window.set_focus();
        hide_main_window_for_ask_selection(app_handle);
        debug!(
            "[overlay] ask selection updated state={} epoch={}",
            payload.state, show_epoch
        );

        schedule_ask_selection_state_retries(panel_window, payload, show_epoch);
    }
}

fn hide_main_window_for_ask_selection(app_handle: &AppHandle) {
    if let Some(main_window) = app_handle.get_webview_window("main") {
        let _ = main_window.hide();
    }
}

fn schedule_ask_selection_state_retries(
    panel_window: tauri::webview::WebviewWindow,
    payload: AskSelectionPayload,
    show_epoch: u64,
) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if ASK_SELECTION_SESSION_EPOCH.load(Ordering::Relaxed) != show_epoch {
            return;
        }
        let _ = panel_window.emit("ask-selection-state", payload.clone());
        std::thread::sleep(std::time::Duration::from_millis(180));
        if ASK_SELECTION_SESSION_EPOCH.load(Ordering::Relaxed) != show_epoch {
            return;
        }
        let _ = panel_window.emit("ask-selection-state", payload);
    });
}

fn schedule_ask_selection_show_retries(
    app_handle: AppHandle,
    payload: AskSelectionPayload,
    position: Option<(f64, f64)>,
    show_epoch: u64,
) {
    std::thread::spawn(move || {
        for delay_ms in [80, 180, 320] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            if ASK_SELECTION_SESSION_EPOCH.load(Ordering::Relaxed) != show_epoch {
                return;
            }

            #[cfg(target_os = "macos")]
            {
                let app = app_handle.clone();
                let payload = payload.clone();
                let _ = app_handle.run_on_main_thread(move || {
                    let _ = show_ask_selection_panel_window(&app, payload, position, show_epoch);
                });
            }

            #[cfg(not(target_os = "macos"))]
            {
                let _ = show_ask_selection_panel_window(
                    &app_handle,
                    payload.clone(),
                    position,
                    show_epoch,
                );
            }
        }
    });
}

fn store_ask_selection_payload(payload: &AskSelectionPayload) {
    if let Ok(mut current) = ASK_SELECTION_LAST_PAYLOAD.lock() {
        *current = Some(payload.clone());
    }
}

pub fn current_ask_selection_payload() -> Option<AskSelectionPayload> {
    ASK_SELECTION_LAST_PAYLOAD
        .lock()
        .ok()
        .and_then(|current| current.clone())
}

pub fn hide_ask_selection_panel(app_handle: &AppHandle) {
    ASK_SELECTION_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut current) = ASK_SELECTION_LAST_PAYLOAD.lock() {
        *current = None;
    }

    #[cfg(target_os = "macos")]
    {
        let app = app_handle.clone();
        let _ = app_handle.run_on_main_thread(move || {
            if let Some(panel_window) = app.get_webview_window(ASK_SELECTION_LABEL) {
                let _ = panel_window.hide();
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(panel_window) = app_handle.get_webview_window(ASK_SELECTION_LABEL) {
            let _ = panel_window.hide();
        }
    }
}

pub fn current_overlay_session_epoch() -> u64 {
    OVERLAY_SESSION_EPOCH.load(Ordering::Relaxed)
}

pub fn cancel_pending_overlay_transitions() {
    OVERLAY_SESSION_EPOCH.fetch_add(1, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_cursor_relative_panel_position_in_bounds, calculate_overlay_position_in_bounds,
        cancel_pending_overlay_transitions, current_overlay_session_epoch, is_mouse_within_monitor,
        overlay_session_epoch_is_current, OverlayBounds, OVERLAY_BOTTOM_OFFSET, OVERLAY_TOP_OFFSET,
    };
    use crate::settings::OverlayPosition;
    use tauri::{PhysicalPosition, PhysicalSize};

    fn assert_f64_eq(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < f64::EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn stale_overlay_session_epoch_is_rejected() {
        let epoch = current_overlay_session_epoch();
        assert!(overlay_session_epoch_is_current(epoch));

        cancel_pending_overlay_transitions();

        assert!(!overlay_session_epoch_is_current(epoch));
        assert!(overlay_session_epoch_is_current(
            current_overlay_session_epoch()
        ));
    }

    #[test]
    fn bottom_overlay_uses_visible_work_area_bottom_edge() {
        let monitor = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1728.0,
            height: 1117.0,
        };
        let work_area = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1728.0,
            height: 1040.0,
        };

        let (x, y) = calculate_overlay_position_in_bounds(
            monitor,
            work_area,
            2.0,
            172.0,
            42.0,
            OverlayPosition::Bottom,
        );

        assert_f64_eq(x, 692.0);
        assert_f64_eq(y, 1040.0 - 84.0 - (OVERLAY_BOTTOM_OFFSET * 2.0));
    }

    #[test]
    fn bottom_overlay_centers_inside_left_or_right_dock_work_area() {
        let monitor = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1728.0,
            height: 1117.0,
        };
        let work_area = OverlayBounds {
            x: 96.0,
            y: 0.0,
            width: 1632.0,
            height: 1117.0,
        };

        let (x, y) = calculate_overlay_position_in_bounds(
            monitor,
            work_area,
            2.0,
            172.0,
            42.0,
            OverlayPosition::Bottom,
        );

        assert_f64_eq(x, 740.0);
        assert_f64_eq(y, 1117.0 - 84.0 - (OVERLAY_BOTTOM_OFFSET * 2.0));
    }

    #[test]
    fn bottom_overlay_matches_old_result_when_work_area_matches_monitor() {
        let monitor = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1728.0,
            height: 1117.0,
        };

        let (x, y) = calculate_overlay_position_in_bounds(
            monitor,
            monitor,
            2.0,
            172.0,
            42.0,
            OverlayPosition::None,
        );

        assert_f64_eq(x, 692.0);
        assert_f64_eq(y, 1117.0 - 84.0 - (OVERLAY_BOTTOM_OFFSET * 2.0));
    }

    #[test]
    fn bottom_overlay_clamps_work_area_that_extends_past_monitor() {
        let monitor = OverlayBounds {
            x: -5120.0,
            y: 178.0,
            width: 5120.0,
            height: 2880.0,
        };
        let bad_work_area = OverlayBounds {
            x: -5120.0,
            y: 356.0,
            width: 5120.0,
            height: 2880.0,
        };

        let (x, y) = calculate_overlay_position_in_bounds(
            monitor,
            bad_work_area,
            2.0,
            172.0,
            42.0,
            OverlayPosition::Bottom,
        );

        assert_f64_eq(x, -2732.0);
        assert_f64_eq(y, 178.0 + 2880.0 - 84.0 - (OVERLAY_BOTTOM_OFFSET * 2.0));
    }

    #[test]
    fn cursor_monitor_check_scales_logical_cursor_for_physical_monitor_bounds() {
        let retina_monitor_pos = PhysicalPosition { x: -5120, y: 178 };
        let retina_monitor_size = PhysicalSize {
            width: 5120,
            height: 2880,
        };

        assert!(is_mouse_within_monitor(
            (-1280.0, 631.0),
            &retina_monitor_pos,
            &retina_monitor_size,
            2.0
        ));

        assert!(!is_mouse_within_monitor(
            (-3280.0, 565.0),
            &retina_monitor_pos,
            &retina_monitor_size,
            2.0
        ));
    }

    #[test]
    fn top_overlay_preserves_full_monitor_vertical_offset() {
        let monitor = OverlayBounds {
            x: 0.0,
            y: 24.0,
            width: 1728.0,
            height: 1117.0,
        };
        let work_area = OverlayBounds {
            x: 96.0,
            y: 72.0,
            width: 1632.0,
            height: 1000.0,
        };

        let (x, y) = calculate_overlay_position_in_bounds(
            monitor,
            work_area,
            2.0,
            172.0,
            42.0,
            OverlayPosition::Top,
        );

        assert_f64_eq(x, 740.0);
        assert_f64_eq(y, 24.0 + (OVERLAY_TOP_OFFSET * 2.0));
    }

    #[test]
    fn ask_selection_panel_prefers_below_right_of_cursor() {
        let work_area = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };

        let (x, y) = calculate_cursor_relative_panel_position_in_bounds(
            200.0, 120.0, work_area, 420.0, 260.0, 18.0, 14.0,
        );

        assert_f64_eq(x, 218.0);
        assert_f64_eq(y, 138.0);
    }

    #[test]
    fn ask_selection_panel_flips_and_clamps_near_screen_edge() {
        let work_area = OverlayBounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };

        let (x, y) = calculate_cursor_relative_panel_position_in_bounds(
            1380.0, 850.0, work_area, 420.0, 260.0, 18.0, 14.0,
        );

        assert_f64_eq(x, 942.0);
        assert_f64_eq(y, 572.0);
    }
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
