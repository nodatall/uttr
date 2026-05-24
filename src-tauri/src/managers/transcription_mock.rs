// CI-only mock TranscriptionManager - avoids whisper/Vulkan dependencies.
// This file is copied over transcription.rs during CI tests.
// Existing tests don't exercise transcription, so this is safe.

use crate::managers::model::ModelManager;
use crate::managers::audio::AudioRecordingManager;
use anyhow::Result;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize)]
pub struct ModelStateEvent {
    pub event_type: String,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct TranscriptionManager {
    #[allow(dead_code)]
    app_handle: AppHandle,
    cancel_requested: Arc<AtomicBool>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle, _model_manager: Arc<ModelManager>) -> Result<Self> {
        Ok(Self {
            app_handle: app_handle.clone(),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn is_model_loaded(&self) -> bool {
        false
    }

    pub fn unload_model(&self) -> Result<()> {
        Ok(())
    }

    pub fn maybe_unload_immediately(&self, _context: &str) {}

    pub fn load_model(&self, _model_id: &str) -> Result<()> {
        Ok(())
    }

    pub fn initiate_model_load(&self) {}

    pub fn get_current_model(&self) -> Option<String> {
        None
    }

    pub async fn transcribe(&self, _audio: Vec<f32>) -> Result<String> {
        Ok(String::new())
    }

    pub async fn transcribe_with_source(
        &self,
        audio: Vec<f32>,
        _source: Option<&str>,
    ) -> Result<String> {
        self.transcribe(audio).await
    }

    pub fn start_incremental_session(
        &self,
        _binding_id: &str,
        _audio_manager: Arc<AudioRecordingManager>,
    ) -> Result<()> {
        Ok(())
    }

    pub async fn finish_incremental_session(
        &self,
        _binding_id: &str,
        _final_samples: &[f32],
    ) -> Result<String> {
        Err(anyhow::anyhow!(
            "incremental transcription is unavailable in CI mock"
        ))
    }

    pub fn signal_incremental_stop(&self, _binding_id: &str) {}

    pub fn has_incremental_session(&self, _binding_id: &str) -> bool {
        false
    }

    pub fn has_incremental_progress(&self, _binding_id: &str) -> bool {
        false
    }

    pub fn cancel_incremental_session(&self) {}

    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Relaxed);
    }

    pub fn clear_cancel_request(&self) {
        self.cancel_requested.store(false, Ordering::Relaxed);
    }

    pub fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Relaxed)
    }
}

pub(crate) fn sanitize_transcription_audio(mut audio: Vec<f32>) -> Vec<f32> {
    for sample in &mut audio {
        if !sample.is_finite() {
            *sample = 0.0;
            continue;
        }

        *sample = (*sample).clamp(-1.0, 1.0);
    }

    audio
}

pub(crate) fn stitch_transcription_text(existing: &mut String, incoming: &str) {
    let incoming_trimmed = incoming.trim();
    if incoming_trimmed.is_empty() {
        return;
    }

    if existing.trim().is_empty() {
        *existing = incoming_trimmed.to_string();
        return;
    }

    if !existing.ends_with(' ') {
        existing.push(' ');
    }
    existing.push_str(incoming_trimmed);
}
