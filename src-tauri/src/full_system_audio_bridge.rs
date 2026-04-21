use once_cell::sync::Lazy;
use std::ffi::c_void;
use std::os::raw::c_int;
use std::sync::{Arc, Mutex};
use std::{mem, ptr, slice};

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
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FullSystemAudioPcmBuffer {
    pub samples: *mut f32,
    pub sample_count: usize,
    pub sample_rate: i32,
    pub channel_count: i32,
}

unsafe impl Send for FullSystemAudioPcmBuffer {}
unsafe impl Sync for FullSystemAudioPcmBuffer {}

#[derive(Debug, Clone, PartialEq)]
pub struct FullSystemAudioCapturedPcm {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channel_count: usize,
}

type LiveLevelCallback = Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>;
static LIVE_LEVEL_CALLBACK: Lazy<Mutex<Option<LiveLevelCallback>>> = Lazy::new(|| Mutex::new(None));

#[repr(C)]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FullSystemAudioStopResult {
    pub stopped: c_int,
    pub sample_rate: i32,
    pub channel_count: i32,
    pub frame_count: i64,
    pub pcm: FullSystemAudioPcmBuffer,
}

unsafe impl Send for FullSystemAudioStopResult {}
unsafe impl Sync for FullSystemAudioStopResult {}

impl FullSystemAudioPcmBuffer {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_samples(samples: &[f32], sample_rate: i32, channel_count: i32) -> Self {
        if samples.is_empty() {
            return Self {
                samples: ptr::null_mut(),
                sample_count: 0,
                sample_rate,
                channel_count,
            };
        }

        unsafe {
            let byte_len = samples.len() * mem::size_of::<f32>();
            let raw_ptr = malloc(byte_len) as *mut f32;
            if raw_ptr.is_null() {
                return Self::default();
            }

            ptr::copy_nonoverlapping(samples.as_ptr(), raw_ptr, samples.len());
            Self {
                samples: raw_ptr,
                sample_count: samples.len(),
                sample_rate,
                channel_count,
            }
        }
    }

    pub fn take_samples(&mut self) -> Option<FullSystemAudioCapturedPcm> {
        if self.samples.is_null() || self.sample_count == 0 {
            self.samples = ptr::null_mut();
            self.sample_count = 0;
            return None;
        }

        let sample_rate = match u32::try_from(self.sample_rate) {
            Ok(value) => value,
            Err(_) => {
                free_samples(self.samples);
                self.samples = ptr::null_mut();
                self.sample_count = 0;
                return None;
            }
        };
        let channel_count = match usize::try_from(self.channel_count) {
            Ok(value) => value,
            Err(_) => {
                free_samples(self.samples);
                self.samples = ptr::null_mut();
                self.sample_count = 0;
                return None;
            }
        };

        let samples = unsafe { slice::from_raw_parts(self.samples, self.sample_count).to_vec() };
        free_samples(self.samples);
        self.samples = ptr::null_mut();
        self.sample_count = 0;

        Some(FullSystemAudioCapturedPcm {
            samples,
            sample_rate,
            channel_count,
        })
    }
}

unsafe extern "C" {
    fn malloc(size: usize) -> *mut c_void;
}

#[cfg(target_os = "macos")]
extern "C" {
    fn uttr_full_system_audio_set_level_callback(
        callback: Option<unsafe extern "C" fn(*const f32, usize)>,
    );
    fn uttr_full_system_audio_is_supported() -> c_int;
    fn uttr_full_system_audio_preflight_permission() -> c_int;
    fn uttr_full_system_audio_request_permission() -> c_int;
    fn uttr_full_system_audio_start_capture(
        config: *const FullSystemAudioCaptureConfig,
    ) -> FullSystemAudioStartResult;
    fn uttr_full_system_audio_stop_capture() -> FullSystemAudioStopResult;
    fn uttr_full_system_audio_cancel_capture();
    fn uttr_full_system_audio_cleanup_last_session();
    fn uttr_full_system_audio_free_samples(samples: *mut f32);
}

#[cfg(not(target_os = "macos"))]
unsafe extern "C" {
    fn free(ptr: *mut c_void);
}

pub fn owned_pcm_buffer_from_samples(
    samples: &[f32],
    sample_rate: i32,
    channel_count: i32,
) -> FullSystemAudioPcmBuffer {
    FullSystemAudioPcmBuffer::from_samples(samples, sample_rate, channel_count)
}

unsafe extern "C" fn live_level_trampoline(levels: *const f32, count: usize) {
    if levels.is_null() || count == 0 {
        return;
    }

    let callback = LIVE_LEVEL_CALLBACK.lock().unwrap().clone();
    let Some(callback) = callback else {
        return;
    };

    let buckets = unsafe { slice::from_raw_parts(levels, count).to_vec() };
    callback(buckets);
}

pub fn set_live_level_callback<F>(callback: F)
where
    F: Fn(Vec<f32>) + Send + Sync + 'static,
{
    *LIVE_LEVEL_CALLBACK.lock().unwrap() = Some(Arc::new(callback));

    #[cfg(target_os = "macos")]
    unsafe {
        uttr_full_system_audio_set_level_callback(Some(live_level_trampoline));
    }
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

pub fn free_samples(samples: *mut f32) {
    #[cfg(target_os = "macos")]
    unsafe {
        uttr_full_system_audio_free_samples(samples);
    }

    #[cfg(not(target_os = "macos"))]
    unsafe {
        free(samples.cast::<c_void>());
    }
}
