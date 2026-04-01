use crate::audio_feedback;
use crate::audio_toolkit::audio::{list_input_devices, list_output_devices};
use crate::full_system_audio_bridge::{self, FullSystemAudioPermissionState};
use crate::managers::audio::{AudioRecordingManager, MicrophoneMode};
use crate::settings::{get_settings, write_settings};
use log::warn;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Type)]
pub struct CustomSounds {
    start: bool,
    stop: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct FullSystemAudioSupportStatus {
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct FullSystemAudioReadinessStatus {
    pub supported: bool,
    pub ready: bool,
    pub screen_recording_permission_granted: Option<bool>,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct FullSystemAudioToggleResult {
    pub requested_enabled: bool,
    pub stored_enabled: bool,
    pub support: FullSystemAudioSupportStatus,
    pub readiness: FullSystemAudioReadinessStatus,
    pub error: Option<String>,
}

fn custom_sound_exists(app: &AppHandle, sound_type: &str) -> bool {
    app.path()
        .resolve(
            format!("custom_{}.wav", sound_type),
            tauri::path::BaseDirectory::AppData,
        )
        .map_or(false, |path| path.exists())
}

fn full_system_audio_unsupported_reason() -> String {
    "Full-system audio recording is available on macOS 13 or later.".to_string()
}

fn support_status_from_version(
    version: &tauri_plugin_os::Version,
    is_macos_platform: bool,
) -> FullSystemAudioSupportStatus {
    if is_macos_platform {
        match version {
            tauri_plugin_os::Version::Semantic(major, _, _) if *major >= 13 => {
                FullSystemAudioSupportStatus {
                    supported: true,
                    reason: None,
                }
            }
            _ => FullSystemAudioSupportStatus {
                supported: false,
                reason: Some(format!(
                    "{} Detected macOS {}.",
                    full_system_audio_unsupported_reason(),
                    version
                )),
            },
        }
    } else {
        let _ = version;
        FullSystemAudioSupportStatus {
            supported: false,
            reason: Some(full_system_audio_unsupported_reason()),
        }
    }
}

fn support_status_from_environment(
    version: &tauri_plugin_os::Version,
    is_macos_platform: bool,
    bridge_supported: bool,
) -> FullSystemAudioSupportStatus {
    let version_support = support_status_from_version(version, is_macos_platform);

    if !version_support.supported {
        return version_support;
    }

    if bridge_supported {
        FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        }
    } else {
        FullSystemAudioSupportStatus {
            supported: false,
            reason: Some(
                "Full-system audio recording is unavailable in this build of Uttr."
                    .to_string(),
            ),
        }
    }
}

fn full_system_audio_support_status() -> FullSystemAudioSupportStatus {
    support_status_from_environment(
        &tauri_plugin_os::version(),
        cfg!(target_os = "macos"),
        full_system_audio_bridge::is_supported(),
    )
}

fn permission_granted(permission_state: Option<FullSystemAudioPermissionState>) -> Option<bool> {
    permission_state.map(|state| matches!(state, FullSystemAudioPermissionState::Granted))
}

fn readiness_reason_from_permission(
    support: &FullSystemAudioSupportStatus,
    permission_state: Option<FullSystemAudioPermissionState>,
) -> Option<String> {
    if !support.supported {
        return support.reason.clone();
    }

    match permission_state {
        Some(FullSystemAudioPermissionState::Granted) => None,
        Some(FullSystemAudioPermissionState::Denied) => Some(
            "Grant Screen Recording access in System Settings to enable full-system audio recording."
                .to_string(),
        ),
        Some(FullSystemAudioPermissionState::Error) => Some(
            "Uttr could not check Screen Recording access. Open System Settings and try again."
                .to_string(),
        ),
        Some(FullSystemAudioPermissionState::NotDetermined) | None => Some(
            "Screen Recording access is required before full-system audio recording can be enabled."
                .to_string(),
        ),
        Some(FullSystemAudioPermissionState::Unsupported) => support.reason.clone(),
    }
}

fn readiness_status_from_permission(
    support: FullSystemAudioSupportStatus,
    permission_state: Option<FullSystemAudioPermissionState>,
) -> FullSystemAudioReadinessStatus {
    let screen_recording_permission_granted = permission_granted(permission_state);
    let ready = support.supported && screen_recording_permission_granted == Some(true);
    let reason = if ready {
        None
    } else {
        readiness_reason_from_permission(&support, permission_state)
    };

    FullSystemAudioReadinessStatus {
        supported: support.supported,
        ready,
        screen_recording_permission_granted,
        reason,
    }
}

async fn full_system_audio_readiness_status() -> FullSystemAudioReadinessStatus {
    let support = full_system_audio_support_status();
    if !support.supported {
        return readiness_status_from_permission(support, None);
    }

    readiness_status_from_permission(
        support,
        Some(full_system_audio_bridge::preflight_permission()),
    )
}

fn toggle_result_from_readiness(
    requested_enabled: bool,
    support: FullSystemAudioSupportStatus,
    readiness: FullSystemAudioReadinessStatus,
) -> FullSystemAudioToggleResult {
    if requested_enabled && !readiness.ready {
        let error = readiness
            .reason
            .clone()
            .or_else(|| support.reason.clone())
            .or(Some(
                "Full-system audio recording could not be enabled.".to_string(),
            ));

        return FullSystemAudioToggleResult {
            requested_enabled: true,
            stored_enabled: false,
            support,
            readiness,
            error,
        };
    }

    FullSystemAudioToggleResult {
        requested_enabled,
        stored_enabled: requested_enabled,
        support,
        readiness,
        error: None,
    }
}

#[tauri::command]
#[specta::specta]
pub fn check_custom_sounds(app: AppHandle) -> CustomSounds {
    CustomSounds {
        start: custom_sound_exists(&app, "start"),
        stop: custom_sound_exists(&app, "stop"),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct AudioDevice {
    pub index: String,
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
#[specta::specta]
pub fn update_microphone_mode(app: AppHandle, always_on: bool) -> Result<(), String> {
    // Update settings
    let mut settings = get_settings(&app);
    settings.always_on_microphone = always_on;
    write_settings(&app, settings);

    // Update the audio manager mode
    let rm = app.state::<Arc<AudioRecordingManager>>();
    let new_mode = if always_on {
        MicrophoneMode::AlwaysOn
    } else {
        MicrophoneMode::OnDemand
    };

    rm.update_mode(new_mode)
        .map_err(|e| format!("Failed to update microphone mode: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn get_microphone_mode(app: AppHandle) -> Result<bool, String> {
    let settings = get_settings(&app);
    Ok(settings.always_on_microphone)
}

#[tauri::command]
#[specta::specta]
pub fn get_available_microphones() -> Result<Vec<AudioDevice>, String> {
    let devices =
        list_input_devices().map_err(|e| format!("Failed to list audio devices: {}", e))?;

    let mut result = vec![AudioDevice {
        index: "default".to_string(),
        name: "Default".to_string(),
        is_default: true,
    }];

    result.extend(devices.into_iter().map(|d| AudioDevice {
        index: d.index,
        name: d.name,
        is_default: false, // The explicit default is handled separately
    }));

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn set_selected_microphone(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.selected_microphone = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);

    // Update the audio manager to use the new device
    let rm = app.state::<Arc<AudioRecordingManager>>();
    rm.update_selected_device()
        .map_err(|e| format!("Failed to update selected device: {}", e))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_selected_microphone(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .selected_microphone
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn get_available_output_devices() -> Result<Vec<AudioDevice>, String> {
    let devices =
        list_output_devices().map_err(|e| format!("Failed to list output devices: {}", e))?;

    let mut result = vec![AudioDevice {
        index: "default".to_string(),
        name: "Default".to_string(),
        is_default: true,
    }];

    result.extend(devices.into_iter().map(|d| AudioDevice {
        index: d.index,
        name: d.name,
        is_default: false, // The explicit default is handled separately
    }));

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn set_selected_output_device(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.selected_output_device = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_selected_output_device(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .selected_output_device
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn play_test_sound(app: AppHandle, sound_type: String) {
    let sound = match sound_type.as_str() {
        "start" => audio_feedback::SoundType::Start,
        "stop" => audio_feedback::SoundType::Stop,
        _ => {
            warn!("Unknown sound type: {}", sound_type);
            return;
        }
    };
    audio_feedback::play_test_sound(&app, sound);
}

#[tauri::command]
#[specta::specta]
pub fn set_clamshell_microphone(app: AppHandle, device_name: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.clamshell_microphone = if device_name == "default" {
        None
    } else {
        Some(device_name)
    };
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_clamshell_microphone(app: AppHandle) -> Result<String, String> {
    let settings = get_settings(&app);
    Ok(settings
        .clamshell_microphone
        .unwrap_or_else(|| "default".to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn is_recording(app: AppHandle) -> bool {
    let audio_manager = app.state::<Arc<AudioRecordingManager>>();
    audio_manager.is_recording()
}

#[tauri::command]
#[specta::specta]
pub fn get_full_system_audio_support_status() -> FullSystemAudioSupportStatus {
    full_system_audio_support_status()
}

#[tauri::command]
#[specta::specta]
pub async fn get_full_system_audio_readiness_status() -> FullSystemAudioReadinessStatus {
    full_system_audio_readiness_status().await
}

#[tauri::command]
#[specta::specta]
pub async fn set_record_full_system_audio_enabled(
    app: AppHandle,
    enabled: bool,
) -> FullSystemAudioToggleResult {
    let support = full_system_audio_support_status();
    let mut settings = get_settings(&app);
    if !enabled {
        let readiness = full_system_audio_readiness_status().await;
        let toggle = toggle_result_from_readiness(false, support, readiness);
        settings.record_full_system_audio = false;
        write_settings(&app, settings);
        return toggle;
    }

    let requested_permission_state = match support.supported {
        true => match full_system_audio_bridge::preflight_permission() {
            FullSystemAudioPermissionState::Granted => {
                Some(FullSystemAudioPermissionState::Granted)
            }
            _ => Some(full_system_audio_bridge::request_permission()),
        },
        false => None,
    };

    let readiness = readiness_status_from_permission(support.clone(), requested_permission_state);
    let toggle = toggle_result_from_readiness(true, support, readiness);
    settings.record_full_system_audio = toggle.stored_enabled;
    write_settings(&app, settings);

    toggle
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_os::Version;

    #[test]
    fn macos_13_or_later_is_reported_as_supported() {
        let support = support_status_from_environment(&Version::Semantic(13, 0, 0), true, true);

        assert!(support.supported);
        assert!(support.reason.is_none());
    }

    #[test]
    fn macos_12_is_reported_as_unsupported() {
        let support = support_status_from_environment(&Version::Semantic(12, 6, 1), true, true);

        assert!(!support.supported);
        assert!(support
            .reason
            .expect("missing support reason")
            .contains("macOS 13 or later"));
    }

    #[test]
    fn non_macos_platform_is_reported_as_unsupported() {
        let support =
            support_status_from_environment(&Version::Semantic(14, 0, 0), false, false);

        assert!(!support.supported);
        assert!(support
            .reason
            .expect("missing support reason")
            .contains("macOS 13 or later"));
    }

    #[test]
    fn macos_13_without_bridge_support_is_reported_as_unsupported() {
        let support = support_status_from_environment(&Version::Semantic(13, 0, 0), true, false);

        assert!(!support.supported);
        assert!(support
            .reason
            .expect("missing support reason")
            .contains("unavailable in this build"));
    }

    #[test]
    fn readiness_requires_screen_recording_permission_when_supported() {
        let support = FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        };

        let readiness = readiness_status_from_permission(
            support,
            Some(FullSystemAudioPermissionState::NotDetermined),
        );

        assert!(!readiness.ready);
        assert_eq!(readiness.screen_recording_permission_granted, Some(false));
        assert!(readiness
            .reason
            .expect("missing readiness reason")
            .contains("Screen Recording access"));
    }

    #[test]
    fn readiness_is_not_ready_when_support_is_missing() {
        let support = FullSystemAudioSupportStatus {
            supported: false,
            reason: Some("Full-system audio recording is available on macOS 13 or later.".into()),
        };

        let readiness = readiness_status_from_permission(support, None);

        assert!(!readiness.supported);
        assert!(!readiness.ready);
        assert!(readiness.reason.is_some());
    }

    #[test]
    fn toggle_result_refuses_to_store_enabled_when_readiness_fails() {
        let support = FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        };
        let readiness = FullSystemAudioReadinessStatus {
            supported: true,
            ready: false,
            screen_recording_permission_granted: Some(false),
            reason: Some("Grant Screen Recording access.".into()),
        };

        let toggle = toggle_result_from_readiness(true, support, readiness);

        assert!(toggle.requested_enabled);
        assert!(!toggle.stored_enabled);
        assert!(toggle.error.is_some());
    }

    #[test]
    fn toggle_result_stores_enabled_when_readiness_succeeds() {
        let support = FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        };
        let readiness = FullSystemAudioReadinessStatus {
            supported: true,
            ready: true,
            screen_recording_permission_granted: Some(true),
            reason: None,
        };

        let toggle = toggle_result_from_readiness(true, support, readiness);

        assert!(toggle.requested_enabled);
        assert!(toggle.stored_enabled);
        assert!(toggle.error.is_none());
    }

    #[test]
    fn readiness_marks_screen_recording_as_granted_only_when_permission_is_granted() {
        let support = FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        };

        let readiness = readiness_status_from_permission(
            support,
            Some(FullSystemAudioPermissionState::Granted),
        );

        assert!(readiness.ready);
        assert_eq!(readiness.screen_recording_permission_granted, Some(true));
        assert!(readiness.reason.is_none());
    }

    #[test]
    fn readiness_reports_permission_needed_for_denied_state() {
        let support = FullSystemAudioSupportStatus {
            supported: true,
            reason: None,
        };

        let readiness =
            readiness_status_from_permission(support, Some(FullSystemAudioPermissionState::Denied));

        assert!(!readiness.ready);
        assert_eq!(readiness.screen_recording_permission_granted, Some(false));
        assert!(readiness
            .reason
            .expect("missing readiness reason")
            .contains("Grant Screen Recording access"));
    }
}
