use crate::settings::AppSettings;
use once_cell::sync::OnceCell;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_stronghold::stronghold::Stronghold;

const GROQ_SECRET_KEY: &str = "groq";
const STRONGHOLD_VAULT_FILE_NAME: &str = "byok.vault";
static GROQ_VAULT: OnceCell<Arc<GroqVault>> = OnceCell::new();

struct GroqVault {
    stronghold: Stronghold,
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
    let stronghold = Stronghold::new(vault_path(app)?, derive_password(settings))
        .map_err(|error| format!("Failed to initialize Stronghold vault: {error}"))?;

    Ok(GroqVault { stronghold })
}

fn vault(app: &AppHandle, settings: &AppSettings) -> Result<Arc<GroqVault>, String> {
    GROQ_VAULT
        .get_or_try_init(|| init_vault(app, settings).map(Arc::new))
        .map(Arc::clone)
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

pub fn initialize(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let _ = vault(app, settings)?;
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
    let vault = vault(app, settings)?;
    let maybe_bytes = read_store_bytes(&vault)?;
    Ok(maybe_bytes.and_then(|bytes| String::from_utf8(bytes).ok()))
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
