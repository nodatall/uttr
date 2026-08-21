#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(any(target_os = "macos", test))]
fn ioreg_reports_closed_clamshell(output: &str) -> bool {
    output.contains("\"AppleClamshellState\" = Yes")
}

#[cfg(any(target_os = "macos", test))]
fn pmset_reports_internal_battery(output: &str) -> bool {
    output.contains("InternalBattery")
}

/// Checks if the MacBook is in clamshell mode (lid closed with external display)
///
/// This queries the macOS IORegistry for the AppleClamshellState key.
/// Returns true if the lid is closed, false if open.
#[cfg(target_os = "macos")]
pub fn is_clamshell() -> Result<bool, String> {
    let output = Command::new("ioreg")
        .args(["-r", "-k", "AppleClamshellState", "-d", "4"])
        .output()
        .map_err(|e| format!("Failed to execute ioreg: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ioreg command failed with status: {}",
            output.status
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    Ok(ioreg_reports_closed_clamshell(&stdout))
}

/// Checks if the Mac is a laptop by detecting battery presence
///
/// This uses pmset to check for battery information.
/// Returns true if a battery is detected (laptop), false otherwise (desktop)
#[cfg(target_os = "macos")]
#[tauri::command]
#[specta::specta]
pub fn is_laptop() -> Result<bool, String> {
    let output = Command::new("pmset")
        .arg("-g")
        .arg("batt")
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    Ok(pmset_reports_internal_battery(&stdout))
}

/// Stub implementation for non-macOS platforms
/// Always returns false since clamshell mode is macOS-specific
#[cfg(not(target_os = "macos"))]
pub fn is_clamshell() -> Result<bool, String> {
    Ok(false)
}

/// Stub implementation for non-macOS platforms
/// Always returns false since laptop detection is macOS-specific
#[cfg(not(target_os = "macos"))]
#[tauri::command]
#[specta::specta]
pub fn is_laptop() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{ioreg_reports_closed_clamshell, pmset_reports_internal_battery};

    #[test]
    fn parses_ioreg_clamshell_state() {
        for (output, expected) in [
            ("\"AppleClamshellState\" = Yes", true),
            ("\"AppleClamshellState\" = No", false),
            ("unrelated ioreg output", false),
        ] {
            assert_eq!(ioreg_reports_closed_clamshell(output), expected);
        }
    }

    #[test]
    fn parses_pmset_battery_presence() {
        for (output, expected) in [
            (
                "Now drawing from 'Battery Power'\n -InternalBattery-0",
                true,
            ),
            ("Now drawing from 'AC Power'", false),
            ("", false),
        ] {
            assert_eq!(pmset_reports_internal_battery(output), expected);
        }
    }
}
