use crate::access::backend_base_url;
use crate::groq_client::DirectTranscriptionError;
use crate::managers::model::{
    GROQ_MODEL_WHISPER_LARGE_V3, GROQ_MODEL_WHISPER_LARGE_V3_TURBO, OPENAI_MODEL_GPT_4O_TRANSCRIBE,
};
use crate::settings::AppSettings;
use log::debug;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::Serialize;
use std::time::Duration;

const DIAGNOSTICS_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const DIAGNOSTICS_EVENT: &str = "byok_transcription_failed";
const DIAGNOSTICS_FEATURE: &str = "transcription";
const SAMPLE_RATE: usize = 16_000;

static DIAGNOSTICS_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(DIAGNOSTICS_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build diagnostics HTTP client")
});

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ByokFailureDiagnosticPayload {
    install_id: String,
    app_version: String,
    os_name: String,
    os_version_bucket: String,
    feature: String,
    provider: String,
    model_id: String,
    event: String,
    error_kind: String,
    http_status: Option<u16>,
    latency_bucket: String,
    audio_duration_bucket: String,
}

fn normalize_diagnostic_model_id(model_id: &str) -> &'static str {
    match model_id {
        GROQ_MODEL_WHISPER_LARGE_V3 | "whisper-large-v3" => "whisper-large-v3",
        GROQ_MODEL_WHISPER_LARGE_V3_TURBO | "whisper-large-v3-turbo" => "whisper-large-v3-turbo",
        OPENAI_MODEL_GPT_4O_TRANSCRIBE | "gpt-4o-transcribe" => "gpt-4o-transcribe",
        _ => "other",
    }
}

fn current_os_name() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "unknown",
    }
}

fn latency_bucket(elapsed: Duration) -> &'static str {
    let millis = elapsed.as_millis();
    if millis < 1_000 {
        "lt_1s"
    } else if millis < 3_000 {
        "1_3s"
    } else if millis < 10_000 {
        "3_10s"
    } else if millis < 30_000 {
        "10_30s"
    } else {
        "30s_plus"
    }
}

fn audio_duration_bucket(sample_count: usize) -> &'static str {
    let seconds = sample_count as f64 / SAMPLE_RATE as f64;
    if seconds < 5.0 {
        "0_5s"
    } else if seconds < 15.0 {
        "5_15s"
    } else if seconds < 30.0 {
        "15_30s"
    } else if seconds < 60.0 {
        "30_60s"
    } else {
        "60s_plus"
    }
}

pub(crate) fn build_byok_failure_payload(
    settings: &AppSettings,
    model_id: &str,
    sample_count: usize,
    elapsed: Duration,
    error: &DirectTranscriptionError,
) -> Option<ByokFailureDiagnosticPayload> {
    let install_id = settings.install_id.trim();
    if install_id.is_empty() {
        return None;
    }

    Some(ByokFailureDiagnosticPayload {
        install_id: install_id.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os_name: current_os_name().to_string(),
        os_version_bucket: "unknown".to_string(),
        feature: DIAGNOSTICS_FEATURE.to_string(),
        provider: error.provider().key().to_string(),
        model_id: normalize_diagnostic_model_id(model_id).to_string(),
        event: DIAGNOSTICS_EVENT.to_string(),
        error_kind: error.kind().as_str().to_string(),
        http_status: error.status_code(),
        latency_bucket: latency_bucket(elapsed).to_string(),
        audio_duration_bucket: audio_duration_bucket(sample_count).to_string(),
    })
}

async fn post_byok_failure_payload(
    client: &Client,
    base_url: String,
    install_token: String,
    payload: ByokFailureDiagnosticPayload,
) -> Result<(), reqwest::Error> {
    let mut request = client
        .post(format!(
            "{}/api/diagnostics/event",
            base_url.trim_end_matches('/')
        ))
        .json(&payload);

    if !install_token.trim().is_empty() {
        request = request.header("install-token", install_token.trim());
    }

    request.send().await?.error_for_status()?;
    Ok(())
}

pub(crate) fn report_byok_transcription_failure(
    settings: &AppSettings,
    model_id: &str,
    sample_count: usize,
    elapsed: Duration,
    error: &DirectTranscriptionError,
) -> bool {
    let Some(payload) =
        build_byok_failure_payload(settings, model_id, sample_count, elapsed, error)
    else {
        return false;
    };
    let install_token = settings.install_token.clone();
    let base_url = backend_base_url();

    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            post_byok_failure_payload(&DIAGNOSTICS_HTTP_CLIENT, base_url, install_token, payload)
                .await
        {
            debug!("Failed to send BYOK failure diagnostic: {}", error);
        }
    });

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::groq_client::{
        classify_status_error, DirectTranscriptionError, DirectTranscriptionProvider,
    };
    use crate::settings::get_default_settings;
    use reqwest::StatusCode;

    fn settings() -> AppSettings {
        let mut settings = get_default_settings();
        settings.install_id = "install-test-123".to_string();
        settings.install_token = "install-token-test".to_string();
        settings
    }

    #[test]
    fn buckets_latency_and_audio_duration() {
        assert_eq!(latency_bucket(Duration::from_millis(999)), "lt_1s");
        assert_eq!(latency_bucket(Duration::from_millis(1_000)), "1_3s");
        assert_eq!(latency_bucket(Duration::from_millis(3_000)), "3_10s");
        assert_eq!(latency_bucket(Duration::from_millis(10_000)), "10_30s");
        assert_eq!(latency_bucket(Duration::from_millis(30_000)), "30s_plus");

        assert_eq!(audio_duration_bucket(4 * SAMPLE_RATE), "0_5s");
        assert_eq!(audio_duration_bucket(5 * SAMPLE_RATE), "5_15s");
        assert_eq!(audio_duration_bucket(15 * SAMPLE_RATE), "15_30s");
        assert_eq!(audio_duration_bucket(30 * SAMPLE_RATE), "30_60s");
        assert_eq!(audio_duration_bucket(60 * SAMPLE_RATE), "60s_plus");
    }

    #[test]
    fn normalizes_model_ids_to_backend_allowlist() {
        assert_eq!(
            normalize_diagnostic_model_id(GROQ_MODEL_WHISPER_LARGE_V3),
            "whisper-large-v3"
        );
        assert_eq!(
            normalize_diagnostic_model_id("whisper-large-v3-turbo"),
            "whisper-large-v3-turbo"
        );
        assert_eq!(
            normalize_diagnostic_model_id(OPENAI_MODEL_GPT_4O_TRANSCRIBE),
            "gpt-4o-transcribe"
        );
        assert_eq!(normalize_diagnostic_model_id("custom-model"), "other");
    }

    #[test]
    fn payload_contains_only_sanitized_failure_metadata() {
        let error = DirectTranscriptionError::unsupported_feature(
            DirectTranscriptionProvider::OpenAi,
            "OpenAI GPT-4o transcription does not support translation.",
        );

        let payload = build_byok_failure_payload(
            &settings(),
            OPENAI_MODEL_GPT_4O_TRANSCRIBE,
            SAMPLE_RATE * 12,
            Duration::from_secs(2),
            &error,
        )
        .expect("payload");

        assert_eq!(payload.provider, "byok_openai");
        assert_eq!(payload.model_id, "gpt-4o-transcribe");
        assert_eq!(payload.error_kind, "unsupported_feature");
        assert_eq!(payload.http_status, None);
        assert_eq!(payload.latency_bucket, "1_3s");
        assert_eq!(payload.audio_duration_bucket, "5_15s");
    }

    #[test]
    fn provider_body_sentinels_do_not_reach_payload() {
        let sentinel = "secret spoken words sk-test /Users/alice/private.wav https://example.test";
        let _kind = classify_status_error(StatusCode::INTERNAL_SERVER_ERROR);
        let error = DirectTranscriptionError::unsupported_feature(
            DirectTranscriptionProvider::Groq,
            sentinel,
        );

        let serialized = serde_json::to_string(
            &build_byok_failure_payload(
                &settings(),
                GROQ_MODEL_WHISPER_LARGE_V3,
                SAMPLE_RATE,
                Duration::from_secs(1),
                &error,
            )
            .expect("payload"),
        )
        .expect("serialize");

        assert!(!serialized.contains("secret spoken words"));
        assert!(!serialized.contains("sk-test"));
        assert!(!serialized.contains("/Users/alice"));
        assert!(!serialized.contains("https://example.test"));
    }

    #[test]
    fn report_returns_without_surfacing_send_failures() {
        let original_backend_url = std::env::var("UTTR_BACKEND_BASE_URL").ok();
        std::env::set_var("UTTR_BACKEND_BASE_URL", "http://127.0.0.1:1");
        let error = DirectTranscriptionError::unsupported_feature(
            DirectTranscriptionProvider::OpenAi,
            "unsupported",
        );

        assert!(report_byok_transcription_failure(
            &settings(),
            OPENAI_MODEL_GPT_4O_TRANSCRIBE,
            SAMPLE_RATE,
            Duration::from_millis(100),
            &error,
        ));
        if let Some(value) = original_backend_url {
            std::env::set_var("UTTR_BACKEND_BASE_URL", value);
        } else {
            std::env::remove_var("UTTR_BACKEND_BASE_URL");
        }
    }
}
