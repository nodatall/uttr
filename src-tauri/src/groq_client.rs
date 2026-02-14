use hound::{SampleFormat, WavSpec, WavWriter};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::{multipart, Client};
use serde::Deserialize;
use std::io::Cursor;
use std::time::Duration;

const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";

#[derive(Debug, Deserialize)]
struct GroqTranscriptionResponse {
    text: String,
}

fn normalize_language(language: &str) -> Option<&str> {
    match language {
        "" | "auto" => None,
        "zh-Hans" | "zh-Hant" => Some("zh"),
        _ => Some(language),
    }
}

fn build_wav_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = WavWriter::new(&mut cursor, spec)
            .map_err(|e| format!("Failed to create in-memory WAV writer: {}", e))?;

        for sample in samples {
            let sample_i16 = (sample * i16::MAX as f32) as i16;
            writer
                .write_sample(sample_i16)
                .map_err(|e| format!("Failed to encode WAV sample: {}", e))?;
        }

        writer
            .finalize()
            .map_err(|e| format!("Failed to finalize in-memory WAV: {}", e))?;
    }

    Ok(cursor.into_inner())
}

pub async fn transcribe_samples(
    api_key: &str,
    model: &str,
    samples: &[f32],
    selected_language: &str,
    translate_to_english: bool,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Groq API key is required. Add it in Models > Groq Cloud API key.".to_string());
    }

    let wav = build_wav_bytes(samples)?;

    let mut headers = HeaderMap::new();
    let auth = format!("Bearer {}", api_key.trim());
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&auth)
            .map_err(|e| format!("Invalid Groq API key format for header: {}", e))?,
    );

    let client = Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("Failed to build Groq HTTP client: {}", e))?;

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

    let response = client
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read Groq error response body".to_string());
        return Err(format!("Groq API request failed ({}): {}", status, body));
    }

    let parsed: GroqTranscriptionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Groq response: {}", e))?;

    Ok(parsed.text)
}
