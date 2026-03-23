use crate::settings::{
    ensure_install_identity_defaults, get_settings, write_settings, AccessState, AppSettings,
    ByokValidationState, EntitlementState, TrialState,
};
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri::AppHandle;

const BACKEND_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

static BACKEND_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(BACKEND_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build backend HTTP client")
});

#[derive(Debug, Deserialize)]
struct BootstrapResponse {
    trial_state: TrialState,
    access_state: AccessState,
    install_token: String,
}

#[derive(Debug, Deserialize)]
struct EntitlementResponse {
    trial_state: TrialState,
    access_state: AccessState,
    entitlement_state: EntitlementState,
}

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    claim_token: String,
    claim_url: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
struct BootstrapRequest<'a> {
    install_id: &'a str,
    device_fingerprint_hash: &'a str,
    app_version: &'a str,
}

#[derive(Debug, Serialize)]
struct InstallTokenRequest<'a> {
    install_token: &'a str,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct InstallAccessSnapshot {
    pub install_id: String,
    pub device_fingerprint_hash: String,
    pub trial_state: TrialState,
    pub access_state: AccessState,
    pub entitlement_state: EntitlementState,
    pub byok_enabled: bool,
    pub byok_validation_state: ByokValidationState,
    pub has_byok_secret: bool,
    pub has_install_token: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Type)]
pub struct ClaimTokenResult {
    pub claim_token: String,
    pub claim_url: String,
    pub expires_at: String,
}

fn normalize_backend_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "https://uttr.app".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn backend_base_url() -> String {
    normalize_backend_base_url(
        &std::env::var("UTTR_BACKEND_BASE_URL").unwrap_or_else(|_| "https://uttr.app".to_string()),
    )
}

fn backend_url(path: &str) -> String {
    format!("{}/{}", backend_base_url(), path.trim_start_matches('/'))
}

fn access_snapshot(settings: &AppSettings, has_byok_secret: bool) -> InstallAccessSnapshot {
    InstallAccessSnapshot {
        install_id: settings.install_id.clone(),
        device_fingerprint_hash: settings.device_fingerprint_hash.clone(),
        trial_state: settings.anonymous_trial_state,
        access_state: settings.access_state,
        entitlement_state: settings.entitlement_state,
        byok_enabled: settings.byok_enabled,
        byok_validation_state: settings.byok_validation_state,
        has_byok_secret,
        has_install_token: !settings.install_token.trim().is_empty(),
    }
}

fn has_groq_secret(app: &AppHandle, settings: &AppSettings) -> bool {
    crate::byok_secrets::load_groq_api_key(app, settings)
        .map(|value| value.is_some())
        .unwrap_or(false)
}

fn ensure_identity(app: &AppHandle) -> AppSettings {
    let mut settings = get_settings(app);
    if ensure_install_identity_defaults(app, &mut settings) {
        write_settings(app, settings.clone());
    }
    settings
}

async fn bootstrap_install_state_internal(
    app: &AppHandle,
) -> Result<InstallAccessSnapshot, String> {
    let mut settings = ensure_identity(app);
    let response = BACKEND_HTTP_CLIENT
        .post(backend_url("/api/trial/bootstrap"))
        .json(&BootstrapRequest {
            install_id: &settings.install_id,
            device_fingerprint_hash: &settings.device_fingerprint_hash,
            app_version: env!("CARGO_PKG_VERSION"),
        })
        .send()
        .await
        .map_err(|error| format!("Failed to bootstrap install access: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read backend error body".to_string());
        return Err(format!("Backend bootstrap failed ({}): {}", status, body));
    }

    let backend = response
        .json::<BootstrapResponse>()
        .await
        .map_err(|error| format!("Failed to parse bootstrap response: {}", error))?;

    settings.anonymous_trial_state = backend.trial_state;
    settings.access_state = backend.access_state;
    settings.install_token = backend.install_token;
    write_settings(app, settings);

    let refreshed_settings = get_settings(app);
    Ok(access_snapshot(
        &refreshed_settings,
        has_groq_secret(app, &refreshed_settings),
    ))
}

async fn refresh_entitlement_state_internal(
    app: &AppHandle,
) -> Result<InstallAccessSnapshot, String> {
    let mut settings = ensure_identity(app);
    if settings.install_token.trim().is_empty() {
        let _ = bootstrap_install_state_internal(app).await?;
        settings = get_settings(app);
    }

    let response = BACKEND_HTTP_CLIENT
        .get(backend_url("/api/entitlement"))
        .bearer_auth(settings.install_token.trim())
        .send()
        .await
        .map_err(|error| format!("Failed to refresh entitlement: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read backend error body".to_string());
        return Err(format!(
            "Backend entitlement refresh failed ({}): {}",
            status, body
        ));
    }

    let backend = response
        .json::<EntitlementResponse>()
        .await
        .map_err(|error| format!("Failed to parse entitlement response: {}", error))?;

    settings.anonymous_trial_state = backend.trial_state;
    settings.access_state = backend.access_state;
    settings.entitlement_state = backend.entitlement_state;
    write_settings(app, settings);

    let refreshed_settings = get_settings(app);
    Ok(access_snapshot(
        &refreshed_settings,
        has_groq_secret(app, &refreshed_settings),
    ))
}

async fn request_claim_token_internal(app: &AppHandle) -> Result<ClaimTokenResult, String> {
    let mut settings = ensure_identity(app);
    if settings.install_token.trim().is_empty() {
        let _ = bootstrap_install_state_internal(app).await?;
        settings = get_settings(app);
    }

    let response = BACKEND_HTTP_CLIENT
        .post(backend_url("/api/trial/create-claim"))
        .json(&InstallTokenRequest {
            install_token: settings.install_token.trim(),
        })
        .send()
        .await
        .map_err(|error| format!("Failed to request claim token: {}", error))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read backend error body".to_string());
        return Err(format!(
            "Backend claim token request failed ({}): {}",
            status, body
        ));
    }

    let backend = response
        .json::<ClaimResponse>()
        .await
        .map_err(|error| format!("Failed to parse claim token response: {}", error))?;

    Ok(ClaimTokenResult {
        claim_token: backend.claim_token,
        claim_url: backend.claim_url,
        expires_at: backend.expires_at,
    })
}

pub async fn bootstrap_install_state(app: &AppHandle) -> Result<InstallAccessSnapshot, String> {
    bootstrap_install_state_internal(app).await
}

pub async fn refresh_entitlement_state(app: &AppHandle) -> Result<InstallAccessSnapshot, String> {
    refresh_entitlement_state_internal(app).await
}

pub async fn request_claim_token(app: &AppHandle) -> Result<ClaimTokenResult, String> {
    request_claim_token_internal(app).await
}

pub fn get_install_access_snapshot(app: &AppHandle) -> InstallAccessSnapshot {
    let settings = ensure_identity(app);
    access_snapshot(&settings, has_groq_secret(app, &settings))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_backend_base_url() {
        assert_eq!(
            normalize_backend_base_url("https://uttr.app/"),
            "https://uttr.app"
        );
        assert_eq!(normalize_backend_base_url(""), "https://uttr.app");
    }
}
