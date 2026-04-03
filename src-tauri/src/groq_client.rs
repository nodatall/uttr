use crate::access::backend_base_url;
use crate::settings::{AccessState, EntitlementState, TrialState};
use log::debug;
use once_cell::sync::Lazy;
use reqwest::{multipart, Client, StatusCode};
use serde::Deserialize;
use std::time::{Duration, Instant};

const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const GROQ_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const WAV_HEADER_BYTES: usize = 44;
pub const WAV_BYTES_PER_SAMPLE: usize = 2;
pub const DIRECT_GROQ_UPLOAD_LIMIT_BYTES: usize = 25 * 1024 * 1024;
pub const PROXY_GROQ_UPLOAD_LIMIT_BYTES: usize = 100 * 1024 * 1024;
const PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

static GROQ_HTTP_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(GROQ_REQUEST_TIMEOUT)
        .build()
        .expect("Failed to build Groq HTTP client")
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
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err(
            "Groq API key is required. Unlock BYOK in Settings, save the key, and validate it there."
                .to_string(),
        );
    }

    let encode_started = Instant::now();
    let wav = build_wav_bytes(samples)?;
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
        .map_err(|e| format!("Failed to build audio payload: {}", e))?;

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
        .map_err(|e| format!("Groq request failed: {}", e))?;
    let request_elapsed = request_started.elapsed();

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read Groq error response body".to_string());
        return Err(format!("Groq API request failed ({}): {}", status, body));
    }

    let parse_started = Instant::now();
    let parsed: GroqTranscriptionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Groq response: {}", e))?;
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

    #[test]
    fn estimate_wav_size_matches_header_plus_payload() {
        assert_eq!(
            estimate_wav_size_bytes(16_000).unwrap(),
            WAV_HEADER_BYTES + (16_000 * WAV_BYTES_PER_SAMPLE)
        );
    }
}
