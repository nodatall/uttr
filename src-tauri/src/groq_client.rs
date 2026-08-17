use crate::access::backend_base_url;
use crate::settings::{AccessState, EntitlementState, TrialState};
use log::debug;
use once_cell::sync::Lazy;
use reqwest::{multipart, Client, StatusCode};
use serde::Deserialize;
use std::fmt;
use std::time::{Duration, Instant};

const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const OPENAI_DICTATION_PROMPT: &str = "Transcribe short desktop dictation accurately. The speaker may be quiet, fast, or mumbled. If speech is present, transcribe the spoken words verbatim with normal punctuation.";
const GROQ_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const OPENAI_REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
pub const WAV_HEADER_BYTES: usize = 44;
pub const WAV_BYTES_PER_SAMPLE: usize = 2;
pub const DIRECT_GROQ_UPLOAD_LIMIT_BYTES: usize = 25 * 1024 * 1024;
pub const DIRECT_OPENAI_UPLOAD_LIMIT_BYTES: usize = 25 * 1024 * 1024;
pub const PROXY_GROQ_UPLOAD_LIMIT_BYTES: usize = 100 * 1024 * 1024;
const PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

static GROQ_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(GROQ_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build Groq HTTP client")
});

static OPENAI_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(OPENAI_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build OpenAI HTTP client")
});

static PROXY_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(PROXY_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build proxy HTTP client")
});

#[derive(Debug, Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
struct ProxyTranscriptionResponse {
    text: String,
    trial_state: TrialState,
    access_state: AccessState,
    entitlement_state: EntitlementState,
}

#[derive(Debug)]
pub enum ProxyTranscriptionError {
    Request(String),
    Status { status: StatusCode, body: String },
    Parse(String),
}

impl ProxyTranscriptionError {
    pub fn is_retryable(&self) -> bool {
        match self {
            ProxyTranscriptionError::Request(_) => true,
            ProxyTranscriptionError::Status { status, .. } => {
                status.is_server_error()
                    || *status == StatusCode::REQUEST_TIMEOUT
                    || *status == StatusCode::TOO_MANY_REQUESTS
            }
            ProxyTranscriptionError::Parse(_) => true,
        }
    }

    pub fn is_blocked(&self) -> bool {
        matches!(
            self,
            ProxyTranscriptionError::Status { status, .. } if *status == StatusCode::FORBIDDEN
        )
    }

    pub fn to_message(&self) -> String {
        match self {
            ProxyTranscriptionError::Request(message) => message.clone(),
            ProxyTranscriptionError::Status { status, body } => {
                format!("Backend transcription failed ({}): {}", status, body)
            }
            ProxyTranscriptionError::Parse(message) => message.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectTranscriptionProvider {
    Groq,
    OpenAi,
}

impl DirectTranscriptionProvider {
    pub fn key(self) -> &'static str {
        match self {
            DirectTranscriptionProvider::Groq => "byok_groq",
            DirectTranscriptionProvider::OpenAi => "byok_openai",
        }
    }

    fn label(self) -> &'static str {
        match self {
            DirectTranscriptionProvider::Groq => "Groq",
            DirectTranscriptionProvider::OpenAi => "OpenAI",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectTranscriptionErrorKind {
    AuthFailed,
    RateLimited,
    QuotaExceeded,
    Provider4xx,
    Provider5xx,
    Timeout,
    NetworkError,
    ParseFailed,
    PayloadTooLarge,
    UnsupportedFeature,
    MissingApiKey,
    RequestFailed,
    Unknown,
}

impl DirectTranscriptionErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DirectTranscriptionErrorKind::AuthFailed => "auth_failed",
            DirectTranscriptionErrorKind::RateLimited => "rate_limited",
            DirectTranscriptionErrorKind::QuotaExceeded => "quota_exceeded",
            DirectTranscriptionErrorKind::Provider4xx => "provider_4xx",
            DirectTranscriptionErrorKind::Provider5xx => "provider_5xx",
            DirectTranscriptionErrorKind::Timeout => "timeout",
            DirectTranscriptionErrorKind::NetworkError => "network_error",
            DirectTranscriptionErrorKind::ParseFailed => "parse_failed",
            DirectTranscriptionErrorKind::PayloadTooLarge => "payload_too_large",
            DirectTranscriptionErrorKind::UnsupportedFeature => "unsupported_feature",
            DirectTranscriptionErrorKind::MissingApiKey => "missing_api_key",
            DirectTranscriptionErrorKind::RequestFailed => "request_failed",
            DirectTranscriptionErrorKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectTranscriptionError {
    provider: DirectTranscriptionProvider,
    kind: DirectTranscriptionErrorKind,
    status: Option<StatusCode>,
    message: String,
}

impl DirectTranscriptionError {
    pub fn provider(&self) -> DirectTranscriptionProvider {
        self.provider
    }

    pub fn kind(&self) -> DirectTranscriptionErrorKind {
        self.kind
    }

    pub fn status_code(&self) -> Option<u16> {
        self.status.map(|status| status.as_u16())
    }

    pub fn missing_api_key(
        provider: DirectTranscriptionProvider,
        message: impl Into<String>,
    ) -> Self {
        Self::new(
            provider,
            DirectTranscriptionErrorKind::MissingApiKey,
            None,
            message,
        )
    }

    pub fn unsupported_feature(
        provider: DirectTranscriptionProvider,
        message: impl Into<String>,
    ) -> Self {
        Self::new(
            provider,
            DirectTranscriptionErrorKind::UnsupportedFeature,
            None,
            message,
        )
    }

    fn payload_too_large(
        provider: DirectTranscriptionProvider,
        message: impl Into<String>,
    ) -> Self {
        Self::new(
            provider,
            DirectTranscriptionErrorKind::PayloadTooLarge,
            None,
            message,
        )
    }

    fn parse(provider: DirectTranscriptionProvider, message: impl Into<String>) -> Self {
        Self::new(
            provider,
            DirectTranscriptionErrorKind::ParseFailed,
            None,
            message,
        )
    }

    fn request(provider: DirectTranscriptionProvider, error: reqwest::Error) -> Self {
        let kind = classify_request_error(&error);
        Self::new(
            provider,
            kind,
            None,
            format!("{} request failed.", provider.label()),
        )
    }

    fn status(provider: DirectTranscriptionProvider, status: StatusCode) -> Self {
        let kind = classify_status_error(status);
        Self::new(
            provider,
            kind,
            Some(status),
            format!("{} API request failed ({}).", provider.label(), status),
        )
    }

    fn new(
        provider: DirectTranscriptionProvider,
        kind: DirectTranscriptionErrorKind,
        status: Option<StatusCode>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            provider,
            kind,
            status,
            message: message.into(),
        }
    }
}

impl fmt::Display for DirectTranscriptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DirectTranscriptionError {}

pub fn classify_status_error(status: StatusCode) -> DirectTranscriptionErrorKind {
    match status.as_u16() {
        401 | 403 => DirectTranscriptionErrorKind::AuthFailed,
        413 => DirectTranscriptionErrorKind::PayloadTooLarge,
        429 => DirectTranscriptionErrorKind::RateLimited,
        402 => DirectTranscriptionErrorKind::QuotaExceeded,
        400..=499 => DirectTranscriptionErrorKind::Provider4xx,
        500..=599 => DirectTranscriptionErrorKind::Provider5xx,
        _ => DirectTranscriptionErrorKind::Unknown,
    }
}

fn classify_request_error(error: &reqwest::Error) -> DirectTranscriptionErrorKind {
    if error.is_timeout() {
        return DirectTranscriptionErrorKind::Timeout;
    }

    if error.is_connect() {
        return DirectTranscriptionErrorKind::NetworkError;
    }

    DirectTranscriptionErrorKind::RequestFailed
}

#[derive(Debug, Clone)]
pub struct ProxyTranscriptionResult {
    pub text: String,
    pub trial_state: TrialState,
    pub access_state: AccessState,
    pub entitlement_state: EntitlementState,
}

#[derive(Debug, Clone, Default)]
pub struct ProxyTranscriptionMetadata<'a> {
    pub source: Option<&'a str>,
    pub chunk_index: Option<u32>,
    pub chunk_count: Option<u32>,
    pub audio_seconds: Option<u32>,
}

fn normalize_language(language: &str) -> Option<&str> {
    match language {
        "" | "auto" => None,
        "zh-Hans" | "zh-Hant" => Some("zh"),
        _ => Some(language),
    }
}

pub fn estimate_wav_size_bytes(sample_count: usize) -> Result<usize, String> {
    let data_size = sample_count
        .checked_mul(WAV_BYTES_PER_SAMPLE)
        .ok_or_else(|| "Audio too large to encode as WAV".to_string())?;
    WAV_HEADER_BYTES
        .checked_add(data_size)
        .ok_or_else(|| "Audio too large to encode as WAV".to_string())
}

fn build_wav_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
    let wav_size = estimate_wav_size_bytes(samples.len())?;
    let data_size = wav_size
        .checked_sub(WAV_HEADER_BYTES)
        .ok_or_else(|| "Audio too large to encode as WAV".to_string())?;
    let riff_size = 36usize
        .checked_add(data_size)
        .ok_or_else(|| "Audio too large to encode as WAV".to_string())?;

    let mut wav = Vec::with_capacity(wav_size);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(riff_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
    wav.extend_from_slice(&(16000u32 * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_size as u32).to_le_bytes());

    for &sample in samples {
        let sample_i16 = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        wav.extend_from_slice(&sample_i16.to_le_bytes());
    }

    Ok(wav)
}

pub async fn transcribe_samples_direct(
    api_key: &str,
    model: &str,
    samples: &[f32],
    selected_language: &str,
    translate_to_english: bool,
) -> Result<String, DirectTranscriptionError> {
    let provider = DirectTranscriptionProvider::Groq;
    if api_key.trim().is_empty() {
        return Err(DirectTranscriptionError::missing_api_key(
            provider,
            "Groq API key is required. Unlock BYOK in Settings, save the key, and validate it there."
        ));
    }

    let encode_started = Instant::now();
    let wav = build_wav_bytes(samples)
        .map_err(|message| DirectTranscriptionError::payload_too_large(provider, message))?;
    let encode_elapsed = encode_started.elapsed();

    let endpoint = if translate_to_english {
        "audio/translations"
    } else {
        "audio/transcriptions"
    };
    let url = format!("{}/{}", GROQ_BASE_URL, endpoint);

    let file_part = multipart::Part::bytes(wav)
        .file_name("uttr.wav")
        .mime_str("audio/wav")
        .map_err(|_| DirectTranscriptionError::parse(provider, "Failed to build audio payload."))?;

    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .part("file", file_part)
        .text("response_format", "json".to_string());

    if let Some(language) = normalize_language(selected_language) {
        form = form.text("language", language.to_string());
    }

    let request_started = Instant::now();
    let response = GROQ_HTTP_CLIENT
        .post(url)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|error| DirectTranscriptionError::request(provider, error))?;
    let request_elapsed = request_started.elapsed();

    let status = response.status();
    if !status.is_success() {
        return Err(DirectTranscriptionError::status(provider, status));
    }

    let parse_started = Instant::now();
    let parsed: GroqTranscriptionResponse = response
        .json()
        .await
        .map_err(|_| DirectTranscriptionError::parse(provider, "Failed to parse Groq response."))?;
    let parse_elapsed = parse_started.elapsed();

    debug!(
        "Groq direct transcription timing: model={}, samples={}, encode_ms={}, request_ms={}, parse_ms={}",
        model,
        samples.len(),
        encode_elapsed.as_millis(),
        request_elapsed.as_millis(),
        parse_elapsed.as_millis()
    );

    Ok(parsed.text)
}

pub async fn transcribe_samples_direct_openai(
    api_key: &str,
    model: &str,
    samples: &[f32],
    selected_language: &str,
    translate_to_english: bool,
) -> Result<String, DirectTranscriptionError> {
    let provider = DirectTranscriptionProvider::OpenAi;
    if api_key.trim().is_empty() {
        return Err(DirectTranscriptionError::missing_api_key(
            provider,
            "OpenAI API key is required. Add your OpenAI key in Settings -> API Keys.".to_string(),
        ));
    }

    if translate_to_english {
        return Err(DirectTranscriptionError::unsupported_feature(
            provider,
            "OpenAI GPT-4o transcription does not support Uttr's translate-to-English route yet.",
        ));
    }

    let encode_started = Instant::now();
    let wav = build_wav_bytes(samples)
        .map_err(|message| DirectTranscriptionError::payload_too_large(provider, message))?;
    let encode_elapsed = encode_started.elapsed();

    let file_part = multipart::Part::bytes(wav)
        .file_name("uttr.wav")
        .mime_str("audio/wav")
        .map_err(|_| DirectTranscriptionError::parse(provider, "Failed to build audio payload."))?;

    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .part("file", file_part)
        .text("response_format", "json".to_string())
        .text("prompt", OPENAI_DICTATION_PROMPT.to_string());

    if let Some(language) = normalize_language(selected_language) {
        form = form.text("language", language.to_string());
    }

    let request_started = Instant::now();
    let response = OPENAI_HTTP_CLIENT
        .post(format!("{}/audio/transcriptions", OPENAI_BASE_URL))
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|error| DirectTranscriptionError::request(provider, error))?;
    let request_elapsed = request_started.elapsed();

    let status = response.status();
    if !status.is_success() {
        return Err(DirectTranscriptionError::status(provider, status));
    }

    let parse_started = Instant::now();
    let parsed: OpenAiTranscriptionResponse = response.json().await.map_err(|_| {
        DirectTranscriptionError::parse(provider, "Failed to parse OpenAI transcription response.")
    })?;
    let parse_elapsed = parse_started.elapsed();

    debug!(
        "OpenAI direct transcription timing: model={}, samples={}, encode_ms={}, request_ms={}, parse_ms={}",
        model,
        samples.len(),
        encode_elapsed.as_millis(),
        request_elapsed.as_millis(),
        parse_elapsed.as_millis()
    );

    Ok(parsed.text)
}

pub async fn transcribe_samples(
    install_token: &str,
    model: &str,
    samples: &[f32],
    selected_language: &str,
    translate_to_english: bool,
) -> Result<ProxyTranscriptionResult, ProxyTranscriptionError> {
    transcribe_samples_with_metadata(
        install_token,
        model,
        samples,
        selected_language,
        translate_to_english,
        ProxyTranscriptionMetadata::default(),
    )
    .await
}

pub async fn transcribe_samples_with_metadata(
    install_token: &str,
    model: &str,
    samples: &[f32],
    selected_language: &str,
    translate_to_english: bool,
    metadata: ProxyTranscriptionMetadata<'_>,
) -> Result<ProxyTranscriptionResult, ProxyTranscriptionError> {
    if install_token.trim().is_empty() {
        return Err(ProxyTranscriptionError::Request(
            "Install token is required for cloud transcription.".to_string(),
        ));
    }

    let encode_started = Instant::now();
    let wav = build_wav_bytes(samples).map_err(ProxyTranscriptionError::Parse)?;
    let encode_elapsed = encode_started.elapsed();
    let mut form = multipart::Form::new()
        .text("model", model.to_string())
        .part(
            "file",
            multipart::Part::bytes(wav)
                .file_name("uttr.wav")
                .mime_str("audio/wav")
                .map_err(|e| {
                    ProxyTranscriptionError::Parse(format!("Failed to build audio payload: {}", e))
                })?,
        )
        .text("response_format", "json".to_string())
        .text(
            "translate_to_english",
            if translate_to_english {
                "true"
            } else {
                "false"
            },
        );

    if let Some(source) = metadata.source {
        form = form.text("source", source.to_string());
    }
    if let Some(chunk_index) = metadata.chunk_index {
        form = form.text("chunk_index", chunk_index.to_string());
    }
    if let Some(chunk_count) = metadata.chunk_count {
        form = form.text("chunk_count", chunk_count.to_string());
    }
    if let Some(audio_seconds) = metadata.audio_seconds {
        form = form.text("audio_seconds", audio_seconds.to_string());
    }

    if let Some(language) = normalize_language(selected_language) {
        form = form.text("language", language.to_string());
    }

    let request_started = Instant::now();
    let response = PROXY_HTTP_CLIENT
        .post(format!("{}/api/transcribe/cloud", backend_base_url()))
        .header("install-token", install_token.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            ProxyTranscriptionError::Request(format!(
                "Backend transcription request failed: {}",
                error
            ))
        })?;
    let request_elapsed = request_started.elapsed();

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read backend error response body".to_string());
        return Err(ProxyTranscriptionError::Status { status, body });
    }

    let parse_started = Instant::now();
    let parsed = response
        .json::<ProxyTranscriptionResponse>()
        .await
        .map_err(|error| {
            ProxyTranscriptionError::Parse(format!("Failed to parse backend response: {}", error))
        })?;
    let parse_elapsed = parse_started.elapsed();

    debug!(
        "Groq proxy transcription timing: model={}, samples={}, source={:?}, chunk_index={:?}, chunk_count={:?}, audio_seconds={:?}, encode_ms={}, request_ms={}, parse_ms={}",
        model,
        samples.len(),
        metadata.source,
        metadata.chunk_index,
        metadata.chunk_count,
        metadata.audio_seconds,
        encode_elapsed.as_millis(),
        request_elapsed.as_millis(),
        parse_elapsed.as_millis()
    );

    Ok(ProxyTranscriptionResult {
        text: parsed.text,
        trial_state: parsed.trial_state,
        access_state: parsed.access_state,
        entitlement_state: parsed.entitlement_state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn estimate_wav_size_matches_header_plus_payload() {
        assert_eq!(
            estimate_wav_size_bytes(16_000).unwrap(),
            WAV_HEADER_BYTES + (16_000 * WAV_BYTES_PER_SAMPLE)
        );
    }

    #[test]
    fn direct_status_errors_are_classified_without_provider_body() {
        assert_eq!(
            classify_status_error(StatusCode::UNAUTHORIZED),
            DirectTranscriptionErrorKind::AuthFailed
        );
        assert_eq!(
            classify_status_error(StatusCode::TOO_MANY_REQUESTS),
            DirectTranscriptionErrorKind::RateLimited
        );
        assert_eq!(
            classify_status_error(StatusCode::PAYLOAD_TOO_LARGE),
            DirectTranscriptionErrorKind::PayloadTooLarge
        );
        assert_eq!(
            classify_status_error(StatusCode::INTERNAL_SERVER_ERROR),
            DirectTranscriptionErrorKind::Provider5xx
        );

        let sentinel = "transcript sk-test /Users/alice/secret https://example.test";
        let error = DirectTranscriptionError::status(
            DirectTranscriptionProvider::OpenAi,
            StatusCode::BAD_GATEWAY,
        );
        assert!(!error.to_string().contains(sentinel));
        assert_eq!(error.kind(), DirectTranscriptionErrorKind::Provider5xx);
        assert_eq!(error.status_code(), Some(502));
    }
}
