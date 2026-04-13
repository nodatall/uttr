use crate::managers::audio::AudioRecordingManager;
use log::{debug, warn};
use once_cell::sync::OnceCell;
use std::os::raw::c_int;
use std::sync::Arc;

type AppActivationCallback = extern "C" fn();

static RECORDING_MANAGER: OnceCell<Arc<AudioRecordingManager>> = OnceCell::new();

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn uttr_app_activation_monitor_start(callback: Option<AppActivationCallback>) -> c_int;
    fn uttr_app_activation_monitor_stop();
}

extern "C" fn handle_frontmost_app_activation() {
    if let Some(recording_manager) = RECORDING_MANAGER.get() {
        recording_manager.prewarm_for_frontmost_app_activation();
    }
}

pub fn install_frontmost_app_activation_monitor(recording_manager: Arc<AudioRecordingManager>) {
    if RECORDING_MANAGER.set(recording_manager).is_err() {
        debug!("Frontmost app activation monitor was already installed");
        return;
    }

    #[cfg(target_os = "macos")]
    unsafe {
        if uttr_app_activation_monitor_start(Some(handle_frontmost_app_activation)) == 1 {
            debug!("Installed frontmost app activation monitor");
        } else {
            warn!("Failed to install frontmost app activation monitor");
        }
    }
}

#[allow(dead_code)]
pub fn uninstall_frontmost_app_activation_monitor() {
    #[cfg(target_os = "macos")]
    unsafe {
        uttr_app_activation_monitor_stop();
    }
}
