use crate::settings::AppSettings;
use tauri::AppHandle;

const GROQ_SECRET_KEY: &str = "groq";

fn env_groq_api_key() -> Option<String> {
    for key_name in ["UTTR_GROQ_API_KEY", "GROQ_API_KEY"] {
        if let Ok(value) = std::env::var(key_name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn settings_groq_api_key(settings: &AppSettings) -> Option<String> {
    settings
        .post_process_api_keys
        .get(GROQ_SECRET_KEY)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn load_groq_api_key(
    _app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    if let Some(env_key) = env_groq_api_key() {
        return Ok(Some(env_key));
    }

    Ok(settings_groq_api_key(settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn settings_groq_api_key_uses_non_empty_plaintext_value() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("groq".to_string(), " gsk_test ".to_string());

        assert_eq!(
            settings_groq_api_key(&settings).as_deref(),
            Some("gsk_test")
        );
    }

    #[test]
    fn settings_groq_api_key_ignores_missing_or_empty_values() {
        let mut settings = get_default_settings();
        assert_eq!(settings_groq_api_key(&settings), None);

        settings
            .post_process_api_keys
            .insert("groq".to_string(), "   ".to_string());

        assert_eq!(settings_groq_api_key(&settings), None);
    }

    #[test]
    fn env_groq_api_key_uses_uttr_specific_override_first() {
        unsafe {
            std::env::set_var("GROQ_API_KEY", "gsk_general");
            std::env::set_var("UTTR_GROQ_API_KEY", "gsk_uttr");
        }

        assert_eq!(env_groq_api_key().as_deref(), Some("gsk_uttr"));

        unsafe {
            std::env::remove_var("UTTR_GROQ_API_KEY");
            std::env::remove_var("GROQ_API_KEY");
        }
    }
}
