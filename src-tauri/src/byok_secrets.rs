use crate::settings::AppSettings;
use tauri::AppHandle;

const GROQ_SECRET_KEY: &str = "groq";
const OPENAI_SECRET_KEY: &str = "openai";

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

fn env_openai_api_key() -> Option<String> {
    for key_name in ["UTTR_OPENAI_API_KEY", "OPENAI_API_KEY"] {
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
    settings_api_key(settings, GROQ_SECRET_KEY)
}

fn settings_openai_api_key(settings: &AppSettings) -> Option<String> {
    settings_api_key(settings, OPENAI_SECRET_KEY)
}

fn settings_api_key(settings: &AppSettings, provider_id: &str) -> Option<String> {
    settings
        .post_process_api_keys
        .get(provider_id)
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

pub fn load_openai_api_key(
    _app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    if let Some(env_key) = env_openai_api_key() {
        return Ok(Some(env_key));
    }

    Ok(settings_openai_api_key(settings))
}

pub fn has_any_transcription_api_key(app: &AppHandle, settings: &AppSettings) -> bool {
    load_groq_api_key(app, settings)
        .map(|value| value.is_some())
        .unwrap_or(false)
        || load_openai_api_key(app, settings)
            .map(|value| value.is_some())
            .unwrap_or(false)
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

    #[test]
    fn settings_openai_api_key_uses_non_empty_plaintext_value() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("openai".to_string(), " sk-test ".to_string());

        assert_eq!(
            settings_openai_api_key(&settings).as_deref(),
            Some("sk-test")
        );
    }

    #[test]
    fn settings_transcription_api_keys_ignore_empty_values() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("openai".to_string(), "   ".to_string());
        settings
            .post_process_api_keys
            .insert("groq".to_string(), "   ".to_string());

        assert_eq!(settings_openai_api_key(&settings), None);
        assert_eq!(settings_groq_api_key(&settings), None);
    }
}
