use crate::settings::AppSettings;
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use log::warn;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_stronghold::stronghold::Stronghold;

const GROQ_SECRET_KEY: &str = "groq";
const OPENAI_SECRET_KEY: &str = "openai";
const LEGACY_STRONGHOLD_VAULT_FILE_NAME: &str = "byok.vault";
const SECRET_STORE_KEY_FILE: &str = "byok_secrets.key";
const SECRET_STORE_FILE: &str = "byok_secrets.json";
pub const STORED_API_KEY_PLACEHOLDER: &str = "__uttr_api_key_stored__";
static LEGACY_STRONGHOLD_PANIC_HOOK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static LEGACY_STRONGHOLD_MIGRATION_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretPayload {
    #[serde(default)]
    provider_api_keys: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedSecretStore {
    version: u8,
    nonce: String,
    ciphertext: String,
}

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

#[cfg(test)]
fn settings_groq_api_key(settings: &AppSettings) -> Option<String> {
    settings_api_key(settings, GROQ_SECRET_KEY)
}

#[cfg(test)]
fn settings_openai_api_key(settings: &AppSettings) -> Option<String> {
    settings_api_key(settings, OPENAI_SECRET_KEY)
}

fn settings_api_key(settings: &AppSettings, provider_id: &str) -> Option<String> {
    settings
        .post_process_api_keys
        .get(provider_id)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != STORED_API_KEY_PLACEHOLDER)
        .map(ToOwned::to_owned)
}

fn env_provider_api_key(provider_id: &str) -> Option<String> {
    match provider_id {
        GROQ_SECRET_KEY => env_groq_api_key(),
        OPENAI_SECRET_KEY => env_openai_api_key(),
        _ => None,
    }
}

fn legacy_stronghold_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))?
        .join(LEGACY_STRONGHOLD_VAULT_FILE_NAME))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {}", error))
}

fn secret_store_key_path_in_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SECRET_STORE_KEY_FILE)
}

fn secret_store_path_in_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SECRET_STORE_FILE)
}

fn derive_legacy_stronghold_password(settings: &AppSettings) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"uttr/groq-byok/vault");
    hasher.update(settings.install_id.as_bytes());
    hasher.update(settings.device_fingerprint_hash.as_bytes());
    hasher.finalize().to_vec()
}

fn read_legacy_stronghold_groq_api_key(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    let path = legacy_stronghold_vault_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let password = derive_legacy_stronghold_password(settings);
    let _panic_hook_guard = LEGACY_STRONGHOLD_PANIC_HOOK
        .lock()
        .map_err(|_| "Failed to lock legacy Stronghold panic hook guard.".to_string())?;
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let stronghold_result = catch_unwind(AssertUnwindSafe(|| Stronghold::new(path, password)));
    std::panic::set_hook(original_hook);

    let stronghold = stronghold_result
        .map_err(|_| "Legacy Stronghold panicked while opening the Groq BYOK vault.".to_string())?
        .map_err(|error| format!("Failed to open legacy Stronghold BYOK vault: {}", error))?;
    let maybe_bytes = stronghold
        .store()
        .get(GROQ_SECRET_KEY.as_bytes())
        .map_err(|error| format!("Failed to read legacy Stronghold BYOK secret: {}", error))?;

    Ok(maybe_bytes
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty()))
}

#[cfg(unix)]
fn write_private_file(path: &PathBuf, contents: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create secret store directory: {}", error))?;
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Failed to open secret store file: {}", error))?;
    std::io::Write::write_all(&mut file, contents)
        .map_err(|error| format!("Failed to write secret store file: {}", error))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to protect secret store file: {}", error))
}

#[cfg(not(unix))]
fn write_private_file(path: &PathBuf, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create secret store directory: {}", error))?;
    }

    fs::write(path, contents)
        .map_err(|error| format!("Failed to write secret store file: {}", error))
}

fn load_or_create_store_key_in_dir(app_data_dir: &Path) -> Result<[u8; 32], String> {
    let key_path = secret_store_key_path_in_dir(app_data_dir);
    if key_path.exists() {
        let encoded = fs::read_to_string(&key_path)
            .map_err(|error| format!("Failed to read secret store key: {}", error))?;
        let key = BASE64
            .decode(encoded.trim())
            .map_err(|error| format!("Failed to decode secret store key: {}", error))?;
        if key.len() != 32 {
            return Err("Secret store key has invalid length.".to_string());
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&key);
        return Ok(key_bytes);
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    write_private_file(&key_path, BASE64.encode(key).as_bytes())?;
    Ok(key)
}

fn cipher_for_app_data_dir(app_data_dir: &Path) -> Result<Aes256Gcm, String> {
    let key = load_or_create_store_key_in_dir(app_data_dir)?;
    Aes256Gcm::new_from_slice(&key)
        .map_err(|error| format!("Failed to initialize secret cipher: {}", error))
}

#[allow(deprecated)]
fn read_secret_payload_in_dir(app_data_dir: &Path) -> Result<SecretPayload, String> {
    let store_path = secret_store_path_in_dir(app_data_dir);
    if !store_path.exists() {
        return Ok(SecretPayload::default());
    }

    let store_json = fs::read_to_string(&store_path)
        .map_err(|error| format!("Failed to read API key secret store: {}", error))?;
    let store: EncryptedSecretStore = serde_json::from_str(&store_json)
        .map_err(|error| format!("Failed to parse API key secret store: {}", error))?;
    if store.version != 1 {
        return Err(format!(
            "Unsupported API key secret store version: {}",
            store.version
        ));
    }

    let nonce_bytes = BASE64
        .decode(store.nonce)
        .map_err(|error| format!("Failed to decode secret nonce: {}", error))?;
    let ciphertext = BASE64
        .decode(store.ciphertext)
        .map_err(|error| format!("Failed to decode API key secret payload: {}", error))?;
    let plaintext = cipher_for_app_data_dir(app_data_dir)?
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|error| format!("Failed to decrypt API key secret store: {}", error))?;

    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Failed to parse API key secret payload: {}", error))
}

#[allow(deprecated)]
fn write_secret_payload_in_dir(app_data_dir: &Path, payload: &SecretPayload) -> Result<(), String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);

    let plaintext = serde_json::to_vec(payload)
        .map_err(|error| format!("Failed to encode API key secret payload: {}", error))?;
    let ciphertext = cipher_for_app_data_dir(app_data_dir)?
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|error| format!("Failed to encrypt API key secret store: {}", error))?;
    let store = EncryptedSecretStore {
        version: 1,
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    };
    let store_json = serde_json::to_vec_pretty(&store)
        .map_err(|error| format!("Failed to encode API key secret store: {}", error))?;

    write_private_file(&secret_store_path_in_dir(app_data_dir), &store_json)
}

fn stored_provider_api_key(app: &AppHandle, provider_id: &str) -> Result<Option<String>, String> {
    stored_provider_api_key_in_dir(&app_data_dir(app)?, provider_id)
}

fn stored_provider_api_key_in_dir(
    app_data_dir: &Path,
    provider_id: &str,
) -> Result<Option<String>, String> {
    Ok(read_secret_payload_in_dir(app_data_dir)?
        .provider_api_keys
        .get(provider_id)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned))
}

pub fn load_provider_api_key(
    app: &AppHandle,
    settings: &AppSettings,
    provider_id: &str,
) -> Result<Option<String>, String> {
    if let Some(env_key) = env_provider_api_key(provider_id) {
        return Ok(Some(env_key));
    }

    if let Some(secret_key) = stored_provider_api_key(app, provider_id)? {
        return Ok(Some(secret_key));
    }

    Ok(settings_api_key(settings, provider_id))
}

pub fn load_groq_api_key(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    load_provider_api_key(app, settings, GROQ_SECRET_KEY)
}

pub fn load_openai_api_key(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    load_provider_api_key(app, settings, OPENAI_SECRET_KEY)
}

pub fn save_provider_api_key(
    app: &AppHandle,
    provider_id: &str,
    api_key: &str,
) -> Result<(), String> {
    save_provider_api_key_in_dir(&app_data_dir(app)?, provider_id, api_key)
}

fn save_provider_api_key_in_dir(
    app_data_dir: &Path,
    provider_id: &str,
    api_key: &str,
) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return clear_provider_api_key_in_dir(app_data_dir, provider_id);
    }

    let mut payload = read_secret_payload_in_dir(app_data_dir)?;
    payload
        .provider_api_keys
        .insert(provider_id.to_string(), trimmed.to_string());
    write_secret_payload_in_dir(app_data_dir, &payload)
}

pub fn clear_provider_api_key(app: &AppHandle, provider_id: &str) -> Result<(), String> {
    clear_provider_api_key_in_dir(&app_data_dir(app)?, provider_id)
}

fn clear_provider_api_key_in_dir(app_data_dir: &Path, provider_id: &str) -> Result<(), String> {
    let mut payload = read_secret_payload_in_dir(app_data_dir)?;
    payload.provider_api_keys.remove(provider_id);
    write_secret_payload_in_dir(app_data_dir, &payload)
}

pub fn has_any_transcription_api_key(app: &AppHandle, settings: &AppSettings) -> bool {
    load_groq_api_key(app, settings)
        .map(|value| value.is_some())
        .unwrap_or(false)
        || load_openai_api_key(app, settings)
            .map(|value| value.is_some())
            .unwrap_or(false)
}

pub fn has_any_post_process_api_key(app: &AppHandle, settings: &AppSettings) -> bool {
    settings.post_process_providers.iter().any(|provider| {
        load_provider_api_key(app, settings, &provider.id)
            .map(|value| value.is_some())
            .unwrap_or(false)
    })
}

pub fn migrate_plaintext_api_keys(
    app: &AppHandle,
    settings: &mut AppSettings,
) -> Result<bool, String> {
    migrate_plaintext_api_keys_in_dir(&app_data_dir(app)?, settings)
}

fn migrate_plaintext_api_keys_in_dir(
    app_data_dir: &Path,
    settings: &mut AppSettings,
) -> Result<bool, String> {
    let mut changed = false;

    for (provider_id, api_key) in settings.post_process_api_keys.clone() {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed != STORED_API_KEY_PLACEHOLDER {
            save_provider_api_key_in_dir(app_data_dir, &provider_id, trimmed)?;
        }
        settings
            .post_process_api_keys
            .insert(provider_id, String::new());
        changed = true;
    }

    Ok(changed)
}

pub fn spawn_legacy_groq_api_key_migration(app: AppHandle, settings: AppSettings) {
    if LEGACY_STRONGHOLD_MIGRATION_STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    let Ok(vault_path) = legacy_stronghold_vault_path(&app) else {
        return;
    };
    if !vault_path.exists() {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        match stored_provider_api_key(&app, GROQ_SECRET_KEY) {
            Ok(Some(_)) => return,
            Ok(None) => {}
            Err(error) => {
                warn!(
                    "Skipping legacy Groq BYOK migration because the new store could not be read: {}",
                    error
                );
                return;
            }
        }

        match read_legacy_stronghold_groq_api_key(&app, &settings) {
            Ok(Some(legacy_groq_key)) => {
                if let Err(error) = save_provider_api_key(&app, GROQ_SECRET_KEY, &legacy_groq_key) {
                    warn!("Failed to save migrated legacy Groq BYOK key: {}", error);
                }
            }
            Ok(None) => {}
            Err(error) => warn!("Failed to migrate legacy Groq BYOK vault: {}", error),
        }
    });
}

fn redact_api_keys_for_renderer_with_present_ids<I>(settings: &mut AppSettings, provider_ids: I)
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    for api_key in settings.post_process_api_keys.values_mut() {
        api_key.clear();
    }

    for provider_id in provider_ids {
        settings.post_process_api_keys.insert(
            provider_id.as_ref().to_string(),
            STORED_API_KEY_PLACEHOLDER.to_string(),
        );
    }
}

pub fn redact_api_keys_for_renderer(app: &AppHandle, settings: &mut AppSettings) {
    let configured_provider_ids: Vec<String> = settings
        .post_process_providers
        .iter()
        .filter_map(|provider| {
            load_provider_api_key(app, settings, &provider.id)
                .ok()
                .flatten()
                .map(|_| provider.id.clone())
        })
        .collect();

    redact_api_keys_for_renderer_with_present_ids(settings, configured_provider_ids);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;
    use tempfile::TempDir;

    #[test]
    fn settings_groq_api_key_uses_non_empty_legacy_plaintext_value() {
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
    fn settings_api_key_ignores_renderer_placeholder() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("groq".to_string(), STORED_API_KEY_PLACEHOLDER.to_string());

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

    #[test]
    fn plaintext_api_key_migration_moves_keys_to_secret_store_before_serializing_settings() {
        let temp_dir = TempDir::new().unwrap();
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("groq".to_string(), " gsk_upgrade_plaintext ".to_string());
        settings
            .post_process_api_keys
            .insert("openai".to_string(), " sk_upgrade_plaintext ".to_string());

        assert!(migrate_plaintext_api_keys_in_dir(temp_dir.path(), &mut settings).unwrap());

        assert_eq!(
            stored_provider_api_key_in_dir(temp_dir.path(), "groq")
                .unwrap()
                .as_deref(),
            Some("gsk_upgrade_plaintext")
        );
        assert_eq!(
            stored_provider_api_key_in_dir(temp_dir.path(), "openai")
                .unwrap()
                .as_deref(),
            Some("sk_upgrade_plaintext")
        );
        assert_eq!(
            settings
                .post_process_api_keys
                .get("groq")
                .map(String::as_str),
            Some("")
        );
        assert_eq!(
            settings
                .post_process_api_keys
                .get("openai")
                .map(String::as_str),
            Some("")
        );

        let serialized_settings = serde_json::to_string(&settings).unwrap();
        assert!(!serialized_settings.contains("gsk_upgrade_plaintext"));
        assert!(!serialized_settings.contains("sk_upgrade_plaintext"));
    }

    #[test]
    fn redaction_replaces_configured_ids_with_placeholder_only() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("groq".to_string(), "gsk_secret".to_string());
        settings
            .post_process_api_keys
            .insert("openai".to_string(), "sk_secret".to_string());

        redact_api_keys_for_renderer_with_present_ids(&mut settings, ["groq"]);

        assert_eq!(
            settings
                .post_process_api_keys
                .get("groq")
                .map(String::as_str),
            Some(STORED_API_KEY_PLACEHOLDER)
        );
        assert_eq!(
            settings
                .post_process_api_keys
                .get("openai")
                .map(String::as_str),
            Some("")
        );
        assert!(!settings
            .post_process_api_keys
            .values()
            .any(|value| value == "gsk_secret" || value == "sk_secret"));
    }
}
