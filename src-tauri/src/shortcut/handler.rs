//! Shared shortcut event handling logic
//!
//! This module contains the common logic for handling shortcut events,
//! used by both the Tauri and handy-keys implementations.

use log::warn;
use tauri::{AppHandle, Manager};

use crate::actions::ACTION_MAP;
use crate::settings::get_settings;
use crate::transcription_coordinator::{is_transcribe_binding, transcribe_binding_push_to_talk};
use crate::TranscriptionCoordinator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutEventRoute {
    CoordinatorInput,
    CoordinatorCancel,
    ActionStart,
    ActionStop,
    Ignore,
}

fn shortcut_event_route(binding_id: &str, is_pressed: bool) -> ShortcutEventRoute {
    if is_transcribe_binding(binding_id) {
        ShortcutEventRoute::CoordinatorInput
    } else if binding_id == "cancel" {
        if is_pressed {
            ShortcutEventRoute::CoordinatorCancel
        } else {
            ShortcutEventRoute::Ignore
        }
    } else if is_pressed {
        ShortcutEventRoute::ActionStart
    } else {
        ShortcutEventRoute::ActionStop
    }
}

/// Handle a shortcut event from either implementation.
///
/// This function contains the shared logic for:
/// - Looking up the action in ACTION_MAP
/// - Routing the dynamically registered cancel binding to the coordinator
/// - Handling push-to-talk mode (start on press, stop on release)
/// - Handling toggle mode (toggle state on press only)
///
/// # Arguments
/// * `app` - The Tauri app handle
/// * `binding_id` - The ID of the binding (e.g., "transcribe", "cancel")
/// * `hotkey_string` - The string representation of the hotkey
/// * `is_pressed` - Whether this is a key press (true) or release (false)
pub fn handle_shortcut_event(
    app: &AppHandle,
    binding_id: &str,
    hotkey_string: &str,
    is_pressed: bool,
) {
    match shortcut_event_route(binding_id, is_pressed) {
        ShortcutEventRoute::CoordinatorInput => {
            let settings = get_settings(app);
            warn!(
                "[ask-hotkey] handle_shortcut_event binding={} hotkey={} pressed={}",
                binding_id, hotkey_string, is_pressed
            );
            if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
                coordinator.send_input(
                    binding_id,
                    hotkey_string,
                    is_pressed,
                    transcribe_binding_push_to_talk(binding_id, settings.push_to_talk),
                );
            } else {
                warn!("TranscriptionCoordinator is not initialized");
            }
        }
        ShortcutEventRoute::CoordinatorCancel => {
            if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
                coordinator.request_user_cancel();
            } else {
                warn!("TranscriptionCoordinator is not initialized");
            }
        }
        ShortcutEventRoute::ActionStart | ShortcutEventRoute::ActionStop => {
            let Some(action) = ACTION_MAP.get(binding_id) else {
                warn!(
                    "No action defined in ACTION_MAP for shortcut ID '{}'. Shortcut: '{}', Pressed: {}",
                    binding_id, hotkey_string, is_pressed
                );
                return;
            };
            if is_pressed {
                action.start(app, binding_id, hotkey_string);
            } else {
                action.stop(app, binding_id, hotkey_string, 0);
            }
        }
        ShortcutEventRoute::Ignore => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{shortcut_event_route, ShortcutEventRoute};

    #[test]
    fn escape_press_routes_to_coordinator_cancel_without_recording_gate() {
        assert_eq!(
            shortcut_event_route("cancel", true),
            ShortcutEventRoute::CoordinatorCancel
        );
        assert_eq!(
            shortcut_event_route("cancel", false),
            ShortcutEventRoute::Ignore
        );
    }

    #[test]
    fn transcription_shortcuts_still_route_to_coordinator_input() {
        assert_eq!(
            shortcut_event_route("transcribe", true),
            ShortcutEventRoute::CoordinatorInput
        );
        assert_eq!(
            shortcut_event_route("transcribe_full_system_audio", false),
            ShortcutEventRoute::CoordinatorInput
        );
    }
}
