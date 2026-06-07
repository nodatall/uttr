/// Returns the appropriate CPAL host for the current platform.
/// On Linux, uses ALSA host. On other platforms, uses the default host.
pub fn get_cpal_host() -> cpal::Host {
    #[cfg(target_os = "linux")]
    {
        cpal::host_from_id(cpal::HostId::Alsa).unwrap_or_else(|_| cpal::default_host())
    }
    #[cfg(not(target_os = "linux"))]
    {
        cpal::default_host()
    }
}

pub const ROSETTA_COREAUDIO_UNAVAILABLE_MESSAGE: &str = "Audio capture and playback are unavailable while the Intel build of Uttr is running through Rosetta on Apple Silicon. Install the Apple Silicon build instead.";

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn is_running_under_rosetta() -> bool {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_void};
    use std::sync::OnceLock;

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }

    static IS_TRANSLATED: OnceLock<bool> = OnceLock::new();
    *IS_TRANSLATED.get_or_init(|| {
        let name = CString::new("sysctl.proc_translated").expect("static sysctl name");
        let mut value: c_int = 0;
        let mut size = std::mem::size_of::<c_int>();
        let ret = unsafe {
            sysctlbyname(
                name.as_ptr(),
                &mut value as *mut c_int as *mut c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };

        rosetta_sysctl_result_is_translated(ret, value)
    })
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub fn is_running_under_rosetta() -> bool {
    false
}

#[cfg(any(test, all(target_os = "macos", target_arch = "x86_64")))]
fn rosetta_sysctl_result_is_translated(ret: i32, value: i32) -> bool {
    ret == 0 && value == 1
}

#[cfg(test)]
mod tests {
    use super::rosetta_sysctl_result_is_translated;

    #[test]
    fn rosetta_detection_requires_successful_translated_sysctl_value() {
        assert!(rosetta_sysctl_result_is_translated(0, 1));
        assert!(!rosetta_sysctl_result_is_translated(0, 0));
        assert!(!rosetta_sysctl_result_is_translated(-1, 1));
    }
}
