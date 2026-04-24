use crate::settings::{
    ensure_install_identity_defaults, get_settings, write_settings, AccessState, AppSettings,
    ByokValidationState, EntitlementState, TrialState,
};
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
#[cfg(debug_assertions)]
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;
use tauri::AppHandle;

const BACKEND_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_BACKEND_BASE_URL: &str = "https://uttr.pro";
const PREMIUM_FEATURE_ACCESS_MESSAGE: &str = "Upgrade to Pro to use this feature.";
const TRANSCRIPTION_ACCESS_MESSAGE: &str =
    "Your trial has ended. Upgrade to Pro to keep using transcription.";

static BACKEND_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(BACKEND_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build backend HTTP client")
});

#[cfg(debug_assertions)]
static DEV_ACCESS_OVERRIDE: AtomicU8 = AtomicU8::new(0);

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevAccessOverride {
    None,
    Free,
    Trial,
    Pro,
}

#[cfg(debug_assertions)]
impl DevAccessOverride {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Free,
            2 => Self::Trial,
            3 => Self::Pro,
            _ => Self::None,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Free => 1,
            Self::Trial => 2,
            Self::Pro => 3,
        }
    }
}

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
    pub dev_access_override: Option<String>,
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
        DEFAULT_BACKEND_BASE_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn backend_base_url() -> String {
    normalize_backend_base_url(
        &std::env::var("UTTR_BACKEND_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_BACKEND_BASE_URL.to_string()),
    )
}

fn backend_url(path: &str) -> String {
    format!("{}/{}", backend_base_url(), path.trim_start_matches('/'))
}

fn backend_transport_error_hint(target_url: &str, error_message: &str) -> String {
    let lower = error_message.to_ascii_lowercase();

    if lower.contains("dns")
        || lower.contains("resolve")
        || lower.contains("lookup address")
        || lower.contains("no such host")
    {
        return format!(
            "Could not resolve the Uttr backend host at {}. Check DNS/network access or set UTTR_BACKEND_BASE_URL to a reachable deployment.",
            target_url
        );
    }

    if lower.contains("timed out") || lower.contains("timeout") {
        return format!(
            "The request to {} timed out. The backend may be down or the network path is too slow.",
            target_url
        );
    }

    if lower.contains("certificate") || lower.contains("tls") {
        return format!(
            "TLS validation failed while connecting to {}. Check the backend certificate chain or point UTTR_BACKEND_BASE_URL at a valid HTTPS origin.",
            target_url
        );
    }

    if lower.contains("connection")
        || lower.contains("connect error")
        || lower.contains("unreachable")
    {
        return format!(
            "Could not connect to {}. The backend may be unavailable or blocked by the current network.",
            target_url
        );
    }

    format!(
        "The request to {} failed before the backend returned a response.",
        target_url
    )
}

fn format_backend_transport_error(
    operation: &str,
    target_url: &str,
    error: &reqwest::Error,
) -> String {
    let hint = if error.is_timeout() {
        format!(
            "The request to {} timed out. The backend may be down or the network path is too slow.",
            target_url
        )
    } else {
        backend_transport_error_hint(target_url, &error.to_string())
    };

    format!(
        "Failed to {}. {} Original error: {}",
        operation, hint, error
    )
}

fn access_snapshot(settings: &AppSettings, has_byok_secret: bool) -> InstallAccessSnapshot {
    let mut snapshot = InstallAccessSnapshot {
        install_id: settings.install_id.clone(),
        device_fingerprint_hash: settings.device_fingerprint_hash.clone(),
        trial_state: settings.anonymous_trial_state,
        access_state: settings.access_state,
        entitlement_state: settings.entitlement_state,
        byok_enabled: settings.byok_enabled,
        byok_validation_state: settings.byok_validation_state,
        has_byok_secret,
        has_install_token: !settings.install_token.trim().is_empty(),
        dev_access_override: None,
    };

    apply_dev_access_override(&mut snapshot);
    snapshot
}

#[cfg(debug_assertions)]
fn apply_dev_access_override(snapshot: &mut InstallAccessSnapshot) {
    match DevAccessOverride::from_u8(DEV_ACCESS_OVERRIDE.load(Ordering::Relaxed)) {
        DevAccessOverride::None => {}
        DevAccessOverride::Free => {
            snapshot.trial_state = TrialState::Expired;
            snapshot.access_state = AccessState::Blocked;
            snapshot.entitlement_state = EntitlementState::Inactive;
            snapshot.has_byok_secret = false;
            snapshot.dev_access_override = Some("free".to_string());
        }
        DevAccessOverride::Trial => {
            snapshot.trial_state = TrialState::Trialing;
            snapshot.access_state = AccessState::Trialing;
            snapshot.entitlement_state = EntitlementState::Inactive;
            snapshot.has_byok_secret = false;
            snapshot.dev_access_override = Some("trial".to_string());
        }
        DevAccessOverride::Pro => {
            snapshot.trial_state = TrialState::Linked;
            snapshot.access_state = AccessState::Subscribed;
            snapshot.entitlement_state = EntitlementState::Active;
            snapshot.has_byok_secret = false;
            snapshot.dev_access_override = Some("pro".to_string());
        }
    }
}

#[cfg(not(debug_assertions))]
fn apply_dev_access_override(_snapshot: &mut InstallAccessSnapshot) {}

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

fn byok_access_snapshot(app: &AppHandle, settings: &AppSettings) -> InstallAccessSnapshot {
    access_snapshot(settings, has_groq_secret(app, settings))
}

async fn bootstrap_install_state_internal(
    app: &AppHandle,
) -> Result<InstallAccessSnapshot, String> {
    let mut settings = ensure_identity(app);
    if has_groq_secret(app, &settings) {
        return Ok(byok_access_snapshot(app, &settings));
    }

    let target_url = backend_url("/api/trial/bootstrap");
    let response = BACKEND_HTTP_CLIENT
        .post(&target_url)
        .json(&BootstrapRequest {
            install_id: &settings.install_id,
            device_fingerprint_hash: &settings.device_fingerprint_hash,
            app_version: env!("CARGO_PKG_VERSION"),
        })
        .send()
        .await
        .map_err(|error| {
            format_backend_transport_error("bootstrap install access", &target_url, &error)
        })?;

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
    if has_groq_secret(app, &settings) {
        return Ok(byok_access_snapshot(app, &settings));
    }

    if settings.install_token.trim().is_empty() {
        let _ = bootstrap_install_state_internal(app).await?;
        settings = get_settings(app);
    }

    let target_url = backend_url("/api/entitlement");
    let response = BACKEND_HTTP_CLIENT
        .get(&target_url)
        .bearer_auth(settings.install_token.trim())
        .send()
        .await
        .map_err(|error| {
            format_backend_transport_error("refresh entitlement", &target_url, &error)
        })?;

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
    if has_groq_secret(app, &settings) {
        return Err("Claim flow is not required when using a Groq BYOK key.".to_string());
    }

    if settings.install_token.trim().is_empty() {
        let _ = bootstrap_install_state_internal(app).await?;
        settings = get_settings(app);
    }

    let target_url = backend_url("/api/trial/create-claim");
    let response = BACKEND_HTTP_CLIENT
        .post(&target_url)
        .json(&InstallTokenRequest {
            install_token: settings.install_token.trim(),
        })
        .send()
        .await
        .map_err(|error| {
            format_backend_transport_error("request a claim token", &target_url, &error)
        })?;

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
    #[cfg(debug_assertions)]
    if dev_access_override() != DevAccessOverride::None {
        return Ok(get_install_access_snapshot(app));
    }

    bootstrap_install_state_internal(app).await
}

pub async fn refresh_entitlement_state(app: &AppHandle) -> Result<InstallAccessSnapshot, String> {
    #[cfg(debug_assertions)]
    if dev_access_override() != DevAccessOverride::None {
        return Ok(get_install_access_snapshot(app));
    }

    refresh_entitlement_state_internal(app).await
}

pub async fn request_claim_token(app: &AppHandle) -> Result<ClaimTokenResult, String> {
    request_claim_token_internal(app).await
}

pub fn premium_feature_access_message() -> &'static str {
    PREMIUM_FEATURE_ACCESS_MESSAGE
}

pub fn transcription_access_message() -> &'static str {
    TRANSCRIPTION_ACCESS_MESSAGE
}

pub fn install_access_allows_transcription(snapshot: &InstallAccessSnapshot) -> bool {
    snapshot.has_byok_secret
        || matches!(snapshot.trial_state, TrialState::New)
        || matches!(
            snapshot.access_state,
            AccessState::Trialing | AccessState::Subscribed
        )
}

pub fn install_access_allows_premium_features(snapshot: &InstallAccessSnapshot) -> bool {
    install_access_allows_transcription(snapshot)
}

pub fn get_install_access_snapshot(app: &AppHandle) -> InstallAccessSnapshot {
    let settings = ensure_identity(app);
    access_snapshot(&settings, has_groq_secret(app, &settings))
}

#[cfg(debug_assertions)]
pub fn dev_access_override() -> DevAccessOverride {
    DevAccessOverride::from_u8(DEV_ACCESS_OVERRIDE.load(Ordering::Relaxed))
}

#[cfg(debug_assertions)]
pub fn set_dev_access_override(value: DevAccessOverride) {
    DEV_ACCESS_OVERRIDE.store(value.as_u8(), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_backend_base_url() {
        assert_eq!(
            normalize_backend_base_url("https://uttr.pro/"),
            DEFAULT_BACKEND_BASE_URL
        );
        assert_eq!(normalize_backend_base_url(""), DEFAULT_BACKEND_BASE_URL);
    }

    #[test]
    fn backend_transport_hint_detects_dns_failures() {
        let hint = backend_transport_error_hint(
            "https://uttr.pro/api/trial/bootstrap",
            "error sending request for url: dns error: failed to lookup address information",
        );

        assert!(hint.contains("Could not resolve the Uttr backend host"));
        assert!(hint.contains("UTTR_BACKEND_BASE_URL"));
    }

    #[test]
    fn backend_transport_hint_detects_connectivity_failures() {
        let hint = backend_transport_error_hint(
            "https://uttr.pro/api/trial/bootstrap",
            "error sending request for url: connection refused",
        );

        assert!(hint.contains("Could not connect to"));
    }

    #[test]
    fn premium_features_are_allowed_for_subscription_or_byok() {
        let subscribed = InstallAccessSnapshot {
            install_id: "install".to_string(),
            device_fingerprint_hash: "fingerprint".to_string(),
            trial_state: TrialState::Trialing,
            access_state: AccessState::Subscribed,
            entitlement_state: EntitlementState::Active,
            byok_enabled: false,
            byok_validation_state: ByokValidationState::Unknown,
            has_byok_secret: false,
            has_install_token: true,
            dev_access_override: None,
        };
        assert!(install_access_allows_premium_features(&subscribed));

        let byok = InstallAccessSnapshot {
            access_state: AccessState::Trialing,
            entitlement_state: EntitlementState::Inactive,
            has_byok_secret: true,
            ..subscribed.clone()
        };
        assert!(install_access_allows_premium_features(&byok));

        let trial = InstallAccessSnapshot {
            access_state: AccessState::Trialing,
            entitlement_state: EntitlementState::Inactive,
            has_byok_secret: false,
            ..subscribed
        };
        assert!(install_access_allows_premium_features(&trial));
    }
}
