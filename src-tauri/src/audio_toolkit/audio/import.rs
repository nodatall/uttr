use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, Resampler};
use std::fs::File;
use std::path::{Path, PathBuf};
use symphonia::core::audio::{AudioBufferRef, SampleBuffer};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::default::{get_codecs, get_probe};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const RESAMPLER_CHUNK_SIZE: usize = 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "ogg"];

#[derive(Debug, Clone)]
pub struct ImportedAudioFile {
    pub path: PathBuf,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

pub fn import_audio_file(path: impl AsRef<Path>) -> Result<ImportedAudioFile> {
    let path = path.as_ref();
    validate_audio_path(path)?;

    let (samples, input_sample_rate) = decode_audio_file(path)?;
    if samples.is_empty() {
        return Err(anyhow!(
            "The selected audio file did not contain any audio samples."
        ));
    }

    let samples = if input_sample_rate == TARGET_SAMPLE_RATE {
        samples
    } else {
        resample_samples(&samples, input_sample_rate, TARGET_SAMPLE_RATE)?
    };

    if samples.is_empty() {
        return Err(anyhow!(
            "The selected audio file did not contain any usable audio."
        ));
    }

    Ok(ImportedAudioFile {
        path: path.to_path_buf(),
        sample_rate: TARGET_SAMPLE_RATE,
        samples,
    })
}

fn validate_audio_path(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(anyhow!("The selected audio file could not be found."));
    }

    if !path.is_file() {
        return Err(anyhow!("The selected path is not a file."));
    }

    let extension =
        normalized_extension(path).ok_or_else(|| anyhow!(unsupported_format_message(None)))?;

    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(anyhow!(unsupported_format_message(Some(&extension))));
    }

    Ok(())
}

fn normalized_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

fn unsupported_format_message(extension: Option<&str>) -> String {
    let supported = SUPPORTED_EXTENSIONS.join(", ");
    match extension {
        Some(extension) => format!(
            "Unsupported audio format '.{}'. Supported formats: {}.",
            extension, supported
        ),
        None => format!(
            "Unsupported audio format. Supported formats: {}.",
            supported
        ),
    }
}

fn decode_audio_file(path: &Path) -> Result<(Vec<f32>, u32)> {
    let file = File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(extension) = normalized_extension(path) {
        hint.with_extension(&extension);
    }

    let probed = get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    )?;

    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| {
        anyhow!("The selected audio file does not contain a supported audio track.")
    })?;

    let track_id = track.id;
    let mut decoder = get_codecs().make(&track.codec_params, &DecoderOptions::default())?;
    let mut samples = Vec::new();
    let mut sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("The selected audio file is missing a sample rate."))?;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                return Err(anyhow!(
                    "The selected audio file requires decoder reset, which is not supported."
                ));
            }
            Err(SymphoniaError::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(err) => return Err(err.into()),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => {
                return Err(anyhow!(
                    "The selected audio file requires decoder reset, which is not supported."
                ));
            }
            Err(err) => return Err(err.into()),
        };

        sample_rate = decoded.spec().rate;
        append_mono_samples(decoded, &mut samples);
    }

    Ok((samples, sample_rate))
}

fn append_mono_samples(decoded: AudioBufferRef<'_>, output: &mut Vec<f32>) {
    let spec = *decoded.spec();
    let duration = decoded.capacity() as u64;
    let channel_count = spec.channels.count();
    let mut sample_buffer = SampleBuffer::<f32>::new(duration, spec);
    sample_buffer.copy_interleaved_ref(decoded);

    if channel_count <= 1 {
        output.extend_from_slice(sample_buffer.samples());
        return;
    }

    for frame in sample_buffer.samples().chunks(channel_count) {
        let sum: f32 = frame.iter().copied().sum();
        output.push(sum / channel_count as f32);
    }
}

fn resample_samples(
    samples: &[f32],
    input_sample_rate: u32,
    output_sample_rate: u32,
) -> Result<Vec<f32>> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut resampler = FftFixedIn::<f32>::new(
        input_sample_rate as usize,
        output_sample_rate as usize,
        RESAMPLER_CHUNK_SIZE,
        1,
        1,
    )?;
    let mut resampled = Vec::new();
    let mut offset = 0usize;

    while offset < samples.len() {
        let end = (offset + RESAMPLER_CHUNK_SIZE).min(samples.len());
        let mut chunk = samples[offset..end].to_vec();
        if chunk.len() < RESAMPLER_CHUNK_SIZE {
            chunk.resize(RESAMPLER_CHUNK_SIZE, 0.0);
        }

        let processed = resampler
            .process(&[&chunk], None)
            .map_err(|err| anyhow!("Failed to resample audio: {}", err))?;
        resampled.extend_from_slice(&processed[0]);
        offset = end;
    }

    let expected_length = ((samples.len() as f64) * output_sample_rate as f64
        / input_sample_rate as f64)
        .round() as usize;
    resampled.truncate(expected_length);
    Ok(resampled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsupported_extensions() {
        let fixture = tempfile::NamedTempFile::with_suffix(".invalid").expect("fixture");
        let result = import_audio_file(fixture.path());
        let err = result.expect_err("unsupported extension should fail");
        assert!(err.to_string().contains("Unsupported audio format"));
    }

    #[test]
    fn resamples_audio_to_target_rate() {
        let source = vec![0.0; 44_100];
        let output = resample_samples(&source, 44_100, TARGET_SAMPLE_RATE).expect("resample");
        assert_eq!(output.len(), TARGET_SAMPLE_RATE as usize);
    }
}
