use std::os::raw::c_int;

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullSystemAudioPermissionState {
    Unsupported = 0,
    NotDetermined = 1,
    Denied = 2,
    Granted = 3,
    Error = 4,
}

impl Default for FullSystemAudioPermissionState {
    fn default() -> Self {
        Self::Unsupported
    }
}

impl From<c_int> for FullSystemAudioPermissionState {
    fn from(value: c_int) -> Self {
        match value {
            1 => Self::NotDetermined,
            2 => Self::Denied,
            3 => Self::Granted,
            4 => Self::Error,
            _ => Self::Unsupported,
        }
    }
}

impl From<FullSystemAudioPermissionState> for c_int {
    fn from(value: FullSystemAudioPermissionState) -> Self {
        value as c_int
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FullSystemAudioCaptureConfig {
    pub preferred_sample_rate: i32,
    pub preferred_channel_count: i32,
    pub capture_microphone: c_int,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FullSystemAudioStartResult {
    pub started: c_int,
    pub permission_state: c_int,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FullSystemAudioStopResult {
    pub stopped: c_int,
    pub sample_rate: i32,
    pub channel_count: i32,
    pub frame_count: i64,
}

#[cfg(target_os = "macos")]
extern "C" {
    fn uttr_full_system_audio_is_supported() -> c_int;
    fn uttr_full_system_audio_preflight_permission() -> c_int;
    fn uttr_full_system_audio_request_permission() -> c_int;
    fn uttr_full_system_audio_start_capture(
        config: *const FullSystemAudioCaptureConfig,
    ) -> FullSystemAudioStartResult;
    fn uttr_full_system_audio_stop_capture() -> FullSystemAudioStopResult;
    fn uttr_full_system_audio_cancel_capture();
    fn uttr_full_system_audio_cleanup_last_session();
}

pub fn is_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { uttr_full_system_audio_is_supported() == 1 }
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn preflight_permission() -> FullSystemAudioPermissionState {
    #[cfg(target_os = "macos")]
    {
        unsafe { uttr_full_system_audio_preflight_permission().into() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        FullSystemAudioPermissionState::Unsupported
    }
}

pub fn request_permission() -> FullSystemAudioPermissionState {
    #[cfg(target_os = "macos")]
    {
        unsafe { uttr_full_system_audio_request_permission().into() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        FullSystemAudioPermissionState::Unsupported
    }
}

pub fn start_capture(config: &FullSystemAudioCaptureConfig) -> FullSystemAudioStartResult {
    #[cfg(target_os = "macos")]
    {
        unsafe { uttr_full_system_audio_start_capture(config) }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = config;
        FullSystemAudioStartResult {
            started: 0,
            permission_state: FullSystemAudioPermissionState::Unsupported.into(),
        }
    }
}

pub fn stop_capture() -> FullSystemAudioStopResult {
    #[cfg(target_os = "macos")]
    {
        unsafe { uttr_full_system_audio_stop_capture() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        FullSystemAudioStopResult::default()
    }
}

pub fn cancel_capture() {
    #[cfg(target_os = "macos")]
    unsafe {
        uttr_full_system_audio_cancel_capture();
    }
}

pub fn cleanup_last_session() {
    #[cfg(target_os = "macos")]
    unsafe {
        uttr_full_system_audio_cleanup_last_session();
    }
}
