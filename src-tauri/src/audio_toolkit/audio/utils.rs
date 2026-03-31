use anyhow::Result;
use hound::{WavSpec, WavWriter};
use log::debug;
use std::path::Path;

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Save audio samples as a WAV file
pub async fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}

const PROXY_TRIM_WINDOW_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) / 100;
const PROXY_TRIM_GUARD_SAMPLES: usize = PROXY_TRIM_WINDOW_SAMPLES / 2;
const PROXY_TRIM_SILENT_RMS: f32 = 0.0025;
const PROXY_TRIM_SILENT_PEAK: f32 = 0.015;

fn is_quiet_audio_window(samples: &[f32]) -> bool {
    if samples.is_empty() {
        return true;
    }

    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f32;

    for &sample in samples {
        let abs = sample.abs();
        peak = peak.max(abs);
        sum_squares += f64::from(sample) * f64::from(sample);
    }

    let rms = (sum_squares / samples.len() as f64).sqrt() as f32;
    rms <= PROXY_TRIM_SILENT_RMS && peak <= PROXY_TRIM_SILENT_PEAK
}

pub fn trim_proxy_upload_audio(samples: &[f32]) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let mut trimmed_end = samples.len();

    while trimmed_end > 0 {
        let window_start = trimmed_end.saturating_sub(PROXY_TRIM_WINDOW_SAMPLES);
        if is_quiet_audio_window(&samples[window_start..trimmed_end]) {
            trimmed_end = window_start;
            continue;
        }

        trimmed_end = (trimmed_end + PROXY_TRIM_GUARD_SAMPLES).min(samples.len());
        break;
    }

    if trimmed_end == 0 {
        Vec::new()
    } else {
        samples[..trimmed_end].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::trim_proxy_upload_audio;

    #[test]
    fn trims_short_clip_padding_from_proxy_audio() {
        let mut samples = vec![0.12f32; 180];
        samples.resize(20_000, 0.0);

        let trimmed = trim_proxy_upload_audio(&samples);

        assert!(trimmed.len() < samples.len());
        assert!(trimmed.len() >= 180);
        assert!(trimmed.iter().take(180).all(|sample| *sample > 0.0));
    }

    #[test]
    fn preserves_active_audio_without_trailing_silence() {
        let samples = vec![0.2f32; 1_600];

        let trimmed = trim_proxy_upload_audio(&samples);

        assert_eq!(trimmed, samples);
    }

    #[test]
    fn removes_all_silence_when_proxy_audio_is_quiet() {
        let samples = vec![0.0f32; 2_400];

        let trimmed = trim_proxy_upload_audio(&samples);

        assert!(trimmed.is_empty());
    }
}
