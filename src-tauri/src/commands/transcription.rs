use crate::access::{
    bootstrap_install_state, get_install_access_snapshot, install_access_allows_premium_features,
    premium_feature_access_message, refresh_entitlement_state,
};
use crate::actions::finalize_transcription_output;
use crate::audio_toolkit::import_audio_file;
use crate::byok_secrets::load_groq_api_key;
use crate::groq_client::{
    self, ProxyTranscriptionMetadata, DIRECT_GROQ_UPLOAD_LIMIT_BYTES, PROXY_GROQ_UPLOAD_LIMIT_BYTES,
};
use crate::managers::model::{groq_api_model_name, is_cloud_model_id, GROQ_MODEL_WHISPER_LARGE_V3};
use crate::managers::transcription::{stitch_transcription_text, TranscriptionManager};
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout, SavedFileTranscription};
use serde::Serialize;
use specta::Type;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const FILE_TRANSCRIPTION_SAMPLE_RATE: usize = 16_000;
const FILE_TRANSCRIPTION_OVERLAP_SAMPLES: usize = FILE_TRANSCRIPTION_SAMPLE_RATE * 10;
const DIRECT_CHUNK_SAFETY_MARGIN_BYTES: usize = 1 * 1024 * 1024;
const PROXY_CHUNK_SAFETY_MARGIN_BYTES: usize = 4 * 1024 * 1024;
const FILE_TRANSCRIPTION_SOURCE: &str = "file_transcription";
const MAX_FILE_TRANSCRIPTION_HISTORY: usize = 5;

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[derive(Serialize, Debug, Clone, Type)]
pub struct FileTranscriptionResult {
    file_name: String,
    transcription_text: String,
    post_processed_text: Option<String>,
}

#[derive(Clone, Serialize)]
struct FileTranscriptionProgressEvent {
    percentage: u8,
    stage: String,
    current_chunk: Option<u32>,
    total_chunks: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileTranscriptionRoute {
    DirectGroq,
    BackendProxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChunkRange {
    start: usize,
    end: usize,
}

fn emit_file_transcription_progress(
    app: &AppHandle,
    percentage: u8,
    stage: impl Into<String>,
    current_chunk: Option<u32>,
    total_chunks: Option<u32>,
) {
    let _ = app.emit(
        "file-transcription-progress",
        FileTranscriptionProgressEvent {
            percentage,
            stage: stage.into(),
            current_chunk,
            total_chunks,
        },
    );
}

fn nonempty_groq_api_key(app: &AppHandle) -> Option<String> {
    let settings = get_settings(app);
    load_groq_api_key(app, &settings)
        .ok()
        .flatten()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

fn resolve_file_transcription_route(app: &AppHandle) -> FileTranscriptionRoute {
    if nonempty_groq_api_key(app).is_some() {
        FileTranscriptionRoute::DirectGroq
    } else {
        FileTranscriptionRoute::BackendProxy
    }
}

fn resolve_file_transcription_model_id(selected_model: &str) -> String {
    if is_cloud_model_id(selected_model) {
        selected_model.to_string()
    } else {
        GROQ_MODEL_WHISPER_LARGE_V3.to_string()
    }
}

fn safe_chunk_limit_bytes(route: FileTranscriptionRoute) -> usize {
    match route {
        FileTranscriptionRoute::DirectGroq => {
            DIRECT_GROQ_UPLOAD_LIMIT_BYTES.saturating_sub(DIRECT_CHUNK_SAFETY_MARGIN_BYTES)
        }
        FileTranscriptionRoute::BackendProxy => {
            PROXY_GROQ_UPLOAD_LIMIT_BYTES.saturating_sub(PROXY_CHUNK_SAFETY_MARGIN_BYTES)
        }
    }
}

fn max_chunk_samples(limit_bytes: usize) -> Result<usize, String> {
    if limit_bytes <= groq_client::WAV_HEADER_BYTES {
        return Err("Configured Groq upload limit is too small for audio chunks.".to_string());
    }

    let samples = (limit_bytes - groq_client::WAV_HEADER_BYTES) / groq_client::WAV_BYTES_PER_SAMPLE;
    if samples <= FILE_TRANSCRIPTION_OVERLAP_SAMPLES {
        return Err(
            "Configured Groq upload limit leaves no room for file transcription chunks."
                .to_string(),
        );
    }

    Ok(samples)
}

fn plan_chunk_ranges(sample_count: usize, limit_bytes: usize) -> Result<Vec<ChunkRange>, String> {
    if sample_count == 0 {
        return Ok(Vec::new());
    }

    let chunk_samples = max_chunk_samples(limit_bytes)?;
    let mut ranges = Vec::new();
    let mut start = 0usize;

    while start < sample_count {
        let end = (start + chunk_samples).min(sample_count);
        ranges.push(ChunkRange { start, end });
        if end == sample_count {
            break;
        }

        let next_start = end.saturating_sub(FILE_TRANSCRIPTION_OVERLAP_SAMPLES);
        if next_start <= start {
            return Err(
                "Failed to plan file transcription chunks without overlap deadlock.".to_string(),
            );
        }
        start = next_start;
    }

    Ok(ranges)
}

fn chunk_unique_audio_seconds(chunk: ChunkRange, current_chunk: u32) -> u32 {
    let unique_start = if current_chunk == 1 {
        chunk.start
    } else {
        chunk
            .start
            .saturating_add(FILE_TRANSCRIPTION_OVERLAP_SAMPLES)
    };
    let unique_samples = chunk.end.saturating_sub(unique_start);
    if unique_samples == 0 {
        0
    } else {
        unique_samples.div_ceil(FILE_TRANSCRIPTION_SAMPLE_RATE) as u32
    }
}

fn updated_file_transcription_history(
    existing: &[SavedFileTranscription],
    new_entry: SavedFileTranscription,
) -> Vec<SavedFileTranscription> {
    let file_name = new_entry.file_name.clone();
    let transcription_text = new_entry.transcription_text.clone();
    let post_processed_text = new_entry.post_processed_text.clone();
    let source_path = new_entry.source_path.clone();
    let mut history = Vec::with_capacity(MAX_FILE_TRANSCRIPTION_HISTORY);
    history.push(new_entry);
    history.extend(
        existing
            .iter()
            .filter(|entry| {
                entry.file_name != file_name
                    || entry.transcription_text != transcription_text
                    || entry.post_processed_text != post_processed_text
                    || entry.source_path != source_path
            })
            .take(MAX_FILE_TRANSCRIPTION_HISTORY - 1)
            .cloned(),
    );
    history
}

fn persist_file_transcription_history(app: &AppHandle, new_entry: Option<SavedFileTranscription>) {
    let mut settings = get_settings(app);
    settings.file_transcription_history = match new_entry {
        Some(entry) => {
            updated_file_transcription_history(&settings.file_transcription_history, entry)
        }
        None => Vec::new(),
    };
    write_settings(app, settings);
}

async fn ensure_backend_install_token(app: &AppHandle) -> Result<String, String> {
    let settings = get_settings(app);
    if settings.install_token.trim().is_empty() {
        bootstrap_install_state(app).await?;
    } else {
        refresh_entitlement_state(app).await?;
    }

    let refreshed = get_settings(app);
    if refreshed.install_token.trim().is_empty() {
        return Err("Install token is required for cloud transcription.".to_string());
    }

    Ok(refreshed.install_token)
}

fn sync_proxy_access_state(
    app: &AppHandle,
    trial_state: crate::settings::TrialState,
    access_state: crate::settings::AccessState,
    entitlement_state: crate::settings::EntitlementState,
) {
    let mut settings = get_settings(app);
    settings.anonymous_trial_state = trial_state;
    settings.access_state = access_state;
    settings.entitlement_state = entitlement_state;
    write_settings(app, settings);
}

async fn transcribe_chunk_with_groq(
    app: &AppHandle,
    route: FileTranscriptionRoute,
    model_id: &str,
    samples: &[f32],
    install_token: Option<&str>,
    selected_language: &str,
    translate_to_english: bool,
    audio_seconds: u32,
    current_chunk: u32,
    total_chunks: u32,
) -> Result<String, String> {
    let groq_model = groq_api_model_name(model_id)
        .ok_or_else(|| format!("Unknown Groq model id: {}", model_id))?;

    match route {
        FileTranscriptionRoute::DirectGroq => {
            let api_key = nonempty_groq_api_key(app).ok_or_else(|| {
                "Groq API key is required for direct file transcription.".to_string()
            })?;
            groq_client::transcribe_samples_direct(
                &api_key,
                groq_model,
                samples,
                selected_language,
                translate_to_english,
            )
            .await
        }
        FileTranscriptionRoute::BackendProxy => {
            let result = groq_client::transcribe_samples_with_metadata(
                install_token
                    .ok_or_else(|| {
                        "Install token is required for backend file transcription.".to_string()
                    })?
                    .trim(),
                groq_model,
                samples,
                selected_language,
                translate_to_english,
                ProxyTranscriptionMetadata {
                    source: Some(FILE_TRANSCRIPTION_SOURCE),
                    chunk_index: Some(current_chunk),
                    chunk_count: Some(total_chunks),
                    audio_seconds: Some(audio_seconds),
                },
            )
            .await
            .map_err(|error| error.to_message())?;
            sync_proxy_access_state(
                app,
                result.trial_state,
                result.access_state,
                result.entitlement_state,
            );
            Ok(result.text)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_model_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.model_unload_timeout = timeout;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn get_model_load_status(
    transcription_manager: State<Arc<TranscriptionManager>>,
) -> Result<ModelLoadStatus, String> {
    Ok(ModelLoadStatus {
        is_loaded: transcription_manager.is_model_loaded(),
        current_model: transcription_manager.get_current_model(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn unload_model_manually(
    transcription_manager: State<Arc<TranscriptionManager>>,
) -> Result<(), String> {
    transcription_manager
        .unload_model()
        .map_err(|e| format!("Failed to unload model: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn clear_file_transcription_history(app: AppHandle) -> Result<(), String> {
    persist_file_transcription_history(&app, None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio_file(
    app: AppHandle,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    path: String,
) -> Result<FileTranscriptionResult, String> {
    let access = get_install_access_snapshot(&app);
    if !install_access_allows_premium_features(&access) {
        return Err(premium_feature_access_message().to_string());
    }

    transcription_manager.clear_cancel_request();
    emit_file_transcription_progress(&app, 5, "Importing audio file", None, None);

    let imported =
        import_audio_file(&path).map_err(|err| format!("Failed to import audio file: {}", err))?;
    let file_name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| imported.path.to_string_lossy().to_string());

    let settings = get_settings(&app);
    let route = resolve_file_transcription_route(&app);
    let model_id = resolve_file_transcription_model_id(&settings.selected_model);
    let chunk_limit_bytes = safe_chunk_limit_bytes(route);
    let chunks = plan_chunk_ranges(imported.samples.len(), chunk_limit_bytes)?;
    if chunks.is_empty() {
        return Err("The selected audio file did not contain any usable audio.".to_string());
    }
    let backend_install_token = if route == FileTranscriptionRoute::BackendProxy {
        Some(ensure_backend_install_token(&app).await?)
    } else {
        None
    };

    emit_file_transcription_progress(
        &app,
        12,
        format!("Preparing {}", file_name),
        None,
        Some(chunks.len() as u32),
    );

    let total_chunks = chunks.len() as u32;
    let mut stitched_transcription = String::new();

    for (index, chunk) in chunks.iter().enumerate() {
        if transcription_manager.is_cancel_requested() {
            return Err("Transcription cancelled".to_string());
        }

        let current_chunk = (index + 1) as u32;
        let progress_percentage = 15u8.saturating_add(
            (((current_chunk - 1) as f32 / total_chunks as f32) * 70.0).round() as u8,
        );
        emit_file_transcription_progress(
            &app,
            progress_percentage.min(85),
            format!("Transcribing chunk {} of {}", current_chunk, total_chunks),
            Some(current_chunk),
            Some(total_chunks),
        );

        let chunk_text = transcribe_chunk_with_groq(
            &app,
            route,
            &model_id,
            &imported.samples[chunk.start..chunk.end],
            backend_install_token.as_deref(),
            &settings.selected_language,
            settings.translate_to_english,
            chunk_unique_audio_seconds(*chunk, current_chunk),
            current_chunk,
            total_chunks,
        )
        .await?;

        if transcription_manager.is_cancel_requested() {
            return Err("Transcription cancelled".to_string());
        }

        stitch_transcription_text(&mut stitched_transcription, &chunk_text);
    }

    emit_file_transcription_progress(&app, 90, "Stitching transcript", None, Some(total_chunks));
    emit_file_transcription_progress(
        &app,
        95,
        "Post-processing transcript",
        None,
        Some(total_chunks),
    );
    let finalized = finalize_transcription_output(
        &app,
        &settings,
        &stitched_transcription,
        settings.post_process_enabled,
    )
    .await;
    emit_file_transcription_progress(
        &app,
        100,
        "Transcription complete",
        None,
        Some(total_chunks),
    );

    let result = FileTranscriptionResult {
        file_name: file_name.clone(),
        transcription_text: stitched_transcription,
        post_processed_text: finalized.post_processed_text.clone(),
    };

    persist_file_transcription_history(
        &app,
        Some(SavedFileTranscription {
            file_name,
            transcription_text: result.transcription_text.clone(),
            post_processed_text: result.post_processed_text.clone(),
            source_path: Some(path),
        }),
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_chunk_plan_stays_under_direct_limit() {
        let limit = safe_chunk_limit_bytes(FileTranscriptionRoute::DirectGroq);
        let ranges = plan_chunk_ranges(FILE_TRANSCRIPTION_SAMPLE_RATE * 60 * 40, limit).unwrap();
        assert!(ranges.len() > 1);
        for range in ranges {
            let bytes = groq_client::estimate_wav_size_bytes(range.end - range.start).unwrap();
            assert!(bytes <= limit);
        }
    }

    #[test]
    fn backend_chunk_plan_stays_under_proxy_limit_and_uses_fewer_chunks() {
        let sample_count = FILE_TRANSCRIPTION_SAMPLE_RATE * 60 * 80;
        let direct_ranges = plan_chunk_ranges(
            sample_count,
            safe_chunk_limit_bytes(FileTranscriptionRoute::DirectGroq),
        )
        .unwrap();
        let proxy_ranges = plan_chunk_ranges(
            sample_count,
            safe_chunk_limit_bytes(FileTranscriptionRoute::BackendProxy),
        )
        .unwrap();
        assert!(proxy_ranges.len() < direct_ranges.len());
        for range in proxy_ranges {
            let bytes = groq_client::estimate_wav_size_bytes(range.end - range.start).unwrap();
            assert!(bytes <= safe_chunk_limit_bytes(FileTranscriptionRoute::BackendProxy));
        }
    }

    #[test]
    fn resolves_selected_groq_model_when_available() {
        assert_eq!(
            resolve_file_transcription_model_id("groq-whisper-large-v3-turbo"),
            "groq-whisper-large-v3-turbo"
        );
    }

    #[test]
    fn defaults_to_groq_large_v3_when_local_model_is_selected() {
        assert_eq!(
            resolve_file_transcription_model_id("parakeet-tdt-0.6b-v3"),
            GROQ_MODEL_WHISPER_LARGE_V3
        );
    }

    #[test]
    fn overlap_only_counts_once_for_usage_seconds() {
        let first = ChunkRange {
            start: 0,
            end: FILE_TRANSCRIPTION_SAMPLE_RATE * 20,
        };
        let second = ChunkRange {
            start: FILE_TRANSCRIPTION_SAMPLE_RATE * 10,
            end: FILE_TRANSCRIPTION_SAMPLE_RATE * 30,
        };

        assert_eq!(chunk_unique_audio_seconds(first, 1), 20);
        assert_eq!(chunk_unique_audio_seconds(second, 2), 10);
    }

    #[test]
    fn newest_file_transcription_is_inserted_first_and_history_is_capped() {
        let existing = (0..5)
            .map(|index| SavedFileTranscription {
                file_name: format!("older-{}.wav", index),
                transcription_text: format!("older transcript {}", index),
                post_processed_text: None,
                source_path: Some(format!("/tmp/older-{}.wav", index)),
            })
            .collect::<Vec<_>>();

        let history = updated_file_transcription_history(
            &existing,
            SavedFileTranscription {
                file_name: "new.wav".to_string(),
                transcription_text: "new transcript".to_string(),
                post_processed_text: Some("new transcript".to_string()),
                source_path: Some("/tmp/new.wav".to_string()),
            },
        );

        assert_eq!(history.len(), 5);
        assert_eq!(history[0].file_name, "new.wav");
        assert_eq!(history[1].file_name, "older-0.wav");
        assert_eq!(history[4].file_name, "older-3.wav");
    }
}
