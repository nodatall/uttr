use crate::actions::finalize_transcription_output;
use crate::audio_toolkit::import_audio_file;
use crate::managers::model::is_cloud_model_id;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout};
use serde::Serialize;
use specta::Type;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[derive(Serialize, Type)]
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

fn restore_previous_model_state(
    transcription_manager: &Arc<TranscriptionManager>,
    previous_model_id: Option<String>,
    previous_is_loaded: bool,
) -> Result<(), String> {
    let current_model_id = transcription_manager.get_current_model();
    let current_is_loaded = transcription_manager.is_model_loaded();

    match previous_model_id {
        Some(previous_model_id) => {
            if current_model_id.as_deref() == Some(previous_model_id.as_str())
                && current_is_loaded == previous_is_loaded
            {
                return Ok(());
            }

            if previous_is_loaded || is_cloud_model_id(&previous_model_id) {
                transcription_manager
                    .load_model(&previous_model_id)
                    .map_err(|err| format!("Failed to restore previous model state: {}", err))
            } else if current_model_id.is_some() || current_is_loaded {
                transcription_manager
                    .unload_model()
                    .map_err(|err| format!("Failed to restore previous model state: {}", err))
            } else {
                Ok(())
            }
        }
        None => {
            if current_model_id.is_some() || current_is_loaded {
                transcription_manager
                    .unload_model()
                    .map_err(|err| format!("Failed to restore previous model state: {}", err))
            } else {
                Ok(())
            }
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
pub async fn transcribe_audio_file(
    app: AppHandle,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    path: String,
) -> Result<FileTranscriptionResult, String> {
    transcription_manager.clear_cancel_request();
    emit_file_transcription_progress(&app, 5, "Importing audio file", None, None);

    let imported =
        import_audio_file(&path).map_err(|err| format!("Failed to import audio file: {}", err))?;
    let file_name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| imported.path.to_string_lossy().to_string());

    emit_file_transcription_progress(&app, 15, format!("Preparing {}", file_name), None, None);

    let settings = get_settings(&app);
    let previous_model_id = transcription_manager.get_current_model();
    let previous_is_loaded = transcription_manager.is_model_loaded();
    let preferred_local_model_id =
        if settings.selected_model.is_empty() || is_cloud_model_id(&settings.selected_model) {
            None
        } else {
            Some(settings.selected_model.as_str())
        };
    let local_model_id = transcription_manager
        .select_preferred_local_model_id(preferred_local_model_id)
        .ok_or_else(|| {
            "File transcription requires a downloaded local model. Download Parakeet V3 or another local model in Models first.".to_string()
        })?;

    let current_model_id = transcription_manager.get_current_model();
    let needs_local_load = current_model_id.as_deref() != Some(local_model_id.as_str())
        || current_model_id
            .as_deref()
            .map(is_cloud_model_id)
            .unwrap_or(false)
        || !transcription_manager.is_model_loaded();
    if needs_local_load {
        emit_file_transcription_progress(
            &app,
            25,
            format!("Loading local model {}", local_model_id),
            None,
            None,
        );
        transcription_manager
            .load_model(&local_model_id)
            .map_err(|err| format!("Failed to load local model for file transcription: {}", err))?;
    }

    emit_file_transcription_progress(&app, 45, "Transcribing audio", None, None);

    let result = async {
        let transcription = transcription_manager
            .transcribe_local_file_with_settings(imported.samples, &settings)
            .await
            .map_err(|err| format!("Failed to transcribe audio file: {}", err))?;

        emit_file_transcription_progress(&app, 90, "Post-processing transcript", None, None);
        let processed_output = finalize_transcription_output(
            &app,
            &settings,
            &transcription,
            settings.post_process_enabled,
        )
        .await;
        emit_file_transcription_progress(&app, 100, "Transcription complete", None, None);

        Ok(FileTranscriptionResult {
            file_name,
            transcription_text: transcription,
            post_processed_text: processed_output.post_processed_text,
        })
    }
    .await;

    let restore_result = restore_previous_model_state(
        transcription_manager.inner(),
        previous_model_id,
        previous_is_loaded,
    );

    match (result, restore_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(err), Ok(())) => Err(err),
        (Ok(_), Err(restore_err)) => Err(restore_err),
        (Err(err), Err(_restore_err)) => Err(err),
    }
}
