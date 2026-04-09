use crate::TranscriptionCoordinator;
use log::{debug, info, warn};
use std::thread;
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use signal_hook::consts::SIGUSR2;
#[cfg(unix)]
use signal_hook::iterator::Signals;

pub const SIGUSR2_TRANSCRIPTION_ENV: &str = "UTTR_ENABLE_SIGUSR2_TRANSCRIPTION";

fn parse_signal_toggle_env(value: Option<&str>) -> Result<bool, &'static str> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };

    if value.eq_ignore_ascii_case("1")
        || value.eq_ignore_ascii_case("true")
        || value.eq_ignore_ascii_case("yes")
        || value.eq_ignore_ascii_case("on")
    {
        return Ok(true);
    }

    if value.eq_ignore_ascii_case("0")
        || value.eq_ignore_ascii_case("false")
        || value.eq_ignore_ascii_case("no")
        || value.eq_ignore_ascii_case("off")
    {
        return Ok(false);
    }

    Err("expected one of: 1, true, yes, on, 0, false, no, off")
}

pub fn signal_toggle_enabled() -> bool {
    let raw_value = std::env::var(SIGUSR2_TRANSCRIPTION_ENV).ok();
    match parse_signal_toggle_env(raw_value.as_deref()) {
        Ok(enabled) => enabled,
        Err(error) => {
            warn!(
                "Ignoring invalid {} value {:?}: {}",
                SIGUSR2_TRANSCRIPTION_ENV, raw_value, error
            );
            false
        }
    }
}

#[cfg(unix)]
pub fn setup_signal_handler(app_handle: AppHandle, mut signals: Signals) {
    debug!("SIGUSR2 signal handler registered");
    thread::spawn(move || {
        for sig in signals.forever() {
            if sig == SIGUSR2 {
                info!("Received SIGUSR2 transcription toggle request");
                debug!("Received SIGUSR2");
                if let Some(c) = app_handle.try_state::<TranscriptionCoordinator>() {
                    c.send_input("transcribe", "SIGUSR2", true, false);
                } else {
                    warn!("TranscriptionCoordinator not initialized");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::parse_signal_toggle_env;

    #[test]
    fn parse_signal_toggle_env_defaults_to_disabled() {
        assert_eq!(parse_signal_toggle_env(None), Ok(false));
        assert_eq!(parse_signal_toggle_env(Some("")), Ok(false));
        assert_eq!(parse_signal_toggle_env(Some("   ")), Ok(false));
    }

    #[test]
    fn parse_signal_toggle_env_accepts_truthy_values() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert_eq!(parse_signal_toggle_env(Some(value)), Ok(true));
        }
    }

    #[test]
    fn parse_signal_toggle_env_accepts_falsey_values() {
        for value in ["0", "false", "FALSE", "no", "off"] {
            assert_eq!(parse_signal_toggle_env(Some(value)), Ok(false));
        }
    }

    #[test]
    fn parse_signal_toggle_env_rejects_invalid_values() {
        assert!(parse_signal_toggle_env(Some("maybe")).is_err());
    }
}
