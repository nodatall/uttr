use crate::settings::AppSettings;
use once_cell::sync::{Lazy, OnceCell};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_stronghold::stronghold::Stronghold;

const GROQ_SECRET_KEY: &str = "groq";
const STRONGHOLD_VAULT_FILE_NAME: &str = "byok.vault";
static GROQ_VAULT: OnceCell<Result<Arc<GroqVault>, String>> = OnceCell::new();
static STRONGHOLD_PANIC_HOOK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

struct GroqVault {
    stronghold: Stronghold,
}

fn legacy_groq_api_key(settings: &AppSettings) -> Option<String> {
    settings
        .post_process_api_keys
        .get(GROQ_SECRET_KEY)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;

    Ok(app_data_dir.join(STRONGHOLD_VAULT_FILE_NAME))
}

fn derive_password(settings: &AppSettings) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"uttr/groq-byok/vault");
    hasher.update(settings.install_id.as_bytes());
    hasher.update(settings.device_fingerprint_hash.as_bytes());
    hasher.finalize().to_vec()
}

fn init_vault(app: &AppHandle, settings: &AppSettings) -> Result<GroqVault, String> {
    let path = vault_path(app)?;
    let password = derive_password(settings);
    let _panic_hook_guard = STRONGHOLD_PANIC_HOOK
        .lock()
        .map_err(|_| "Failed to lock Stronghold panic hook guard.".to_string())?;
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let stronghold_result = catch_unwind(AssertUnwindSafe(|| Stronghold::new(path, password)));
    std::panic::set_hook(original_hook);

    let stronghold = stronghold_result
        .map_err(|_| "Stronghold panicked while initializing the Groq BYOK vault.".to_string())?
        .map_err(|error| format!("Failed to initialize Stronghold vault: {error}"))?;

    Ok(GroqVault { stronghold })
}

fn vault(app: &AppHandle, settings: &AppSettings) -> Result<Arc<GroqVault>, String> {
    GROQ_VAULT
        .get_or_init(|| init_vault(app, settings).map(Arc::new))
        .as_ref()
        .map(Arc::clone)
        .map_err(Clone::clone)
}

fn read_store_bytes(vault: &GroqVault) -> Result<Option<Vec<u8>>, String> {
    let store = vault.stronghold.store();
    store
        .get(GROQ_SECRET_KEY.as_bytes())
        .map_err(|error| format!("Failed to read Groq BYOK secret from Stronghold: {error}"))
}

fn write_store_bytes(vault: &GroqVault, bytes: &[u8]) -> Result<(), String> {
    let store = vault.stronghold.store();
    store
        .insert(GROQ_SECRET_KEY.as_bytes().to_vec(), bytes.to_vec(), None)
        .map_err(|error| format!("Failed to store Groq BYOK secret in Stronghold: {error}"))?;
    vault
        .stronghold
        .save()
        .map_err(|error| format!("Failed to save Stronghold vault: {error}"))?;
    Ok(())
}

fn remove_store_bytes(vault: &GroqVault) -> Result<(), String> {
    let store = vault.stronghold.store();
    store
        .delete(GROQ_SECRET_KEY.as_bytes())
        .map_err(|error| format!("Failed to remove Groq BYOK secret from Stronghold: {error}"))?;
    vault
        .stronghold
        .save()
        .map_err(|error| format!("Failed to save Stronghold vault: {error}"))?;
    Ok(())
}

pub fn store_groq_api_key(
    app: &AppHandle,
    settings: &AppSettings,
    api_key: &str,
) -> Result<(), String> {
    let vault = vault(app, settings)?;
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        remove_store_bytes(&vault)?;
    } else {
        write_store_bytes(&vault, trimmed.as_bytes())?;
    }
    Ok(())
}

pub fn load_groq_api_key(
    app: &AppHandle,
    settings: &AppSettings,
) -> Result<Option<String>, String> {
    let fallback_key = legacy_groq_api_key(settings);

    let vault = match vault(app, settings) {
        Ok(vault) => vault,
        Err(error) => {
            if fallback_key.is_some() {
                return Ok(fallback_key);
            }
            return Err(error);
        }
    };

    let maybe_bytes = read_store_bytes(&vault)?;
    Ok(maybe_bytes
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .or(fallback_key))
}

pub fn migrate_groq_api_key(app: &AppHandle, settings: &mut AppSettings) -> Result<bool, String> {
    let Some(current_key) = settings.post_process_api_keys.get(GROQ_SECRET_KEY) else {
        return Ok(false);
    };

    let trimmed = current_key.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    store_groq_api_key(app, settings, trimmed)?;
    settings
        .post_process_api_keys
        .insert(GROQ_SECRET_KEY.to_string(), String::new());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    #[test]
    fn legacy_groq_api_key_uses_non_empty_plaintext_value() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("groq".to_string(), " gsk_test ".to_string());

        assert_eq!(legacy_groq_api_key(&settings).as_deref(), Some("gsk_test"));
    }

    #[test]
    fn legacy_groq_api_key_ignores_missing_or_empty_values() {
        let mut settings = get_default_settings();
        assert_eq!(legacy_groq_api_key(&settings), None);

        settings
            .post_process_api_keys
            .insert("groq".to_string(), "   ".to_string());
        assert_eq!(legacy_groq_api_key(&settings), None);
    }
}
