use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppContextSnapshot {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    pub unavailable_reason: Option<String>,
}

impl AppContextSnapshot {
    pub fn has_context(&self) -> bool {
        self.app_name
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self
                .bundle_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .window_title
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self
                .selected_text
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }
}

fn clean_field(value: Option<&str>, max_chars: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value == "missing value" {
        return None;
    }

    Some(value.chars().take(max_chars).collect())
}

#[cfg(target_os = "macos")]
pub fn collect_text_context() -> AppContextSnapshot {
    use log::debug;
    use std::process::Command;

    const FIELD_SEPARATOR: char = '\u{1f}';
    const SCRIPT: &str = r#"
set sep to ASCII character 31
set appName to ""
set bundleId to ""
set windowTitle to ""
set selectedText to ""
try
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    try
      set bundleId to bundle identifier of frontApp
    end try
    try
      set windowTitle to name of front window of frontApp
    end try
    try
      set focusedElement to value of attribute "AXFocusedUIElement" of frontApp
      try
        set selectedText to value of attribute "AXSelectedText" of focusedElement
      end try
    end try
  end tell
on error errMsg
  return "ERROR" & sep & errMsg
end try
return appName & sep & bundleId & sep & windowTitle & sep & selectedText
"#;

    let output = match Command::new("osascript").arg("-e").arg(SCRIPT).output() {
        Ok(output) => output,
        Err(error) => {
            return AppContextSnapshot {
                unavailable_reason: Some(format!("Failed to run osascript: {}", error)),
                ..Default::default()
            };
        }
    };

    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return AppContextSnapshot {
            unavailable_reason: Some(if reason.is_empty() {
                "macOS app context script failed".to_string()
            } else {
                reason
            }),
            ..Default::default()
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.trim_end_matches(['\r', '\n']);
    let parts: Vec<&str> = stdout.split(FIELD_SEPARATOR).collect();

    if parts.first() == Some(&"ERROR") {
        let reason = parts
            .get(1)
            .copied()
            .unwrap_or("macOS app context unavailable");
        debug!("macOS app context unavailable: {}", reason);
        return AppContextSnapshot {
            unavailable_reason: Some(reason.to_string()),
            ..Default::default()
        };
    }

    AppContextSnapshot {
        app_name: clean_field(parts.first().copied(), 80),
        bundle_id: clean_field(parts.get(1).copied(), 120),
        window_title: clean_field(parts.get(2).copied(), 160),
        selected_text: clean_field(parts.get(3).copied(), 6_000),
        unavailable_reason: None,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn collect_text_context() -> AppContextSnapshot {
    AppContextSnapshot {
        unavailable_reason: Some("Text context is only available on macOS.".to_string()),
        ..Default::default()
    }
}
