use crate::access::{bootstrap_install_state, refresh_entitlement_state, request_claim_token};
use crate::audio_toolkit::{
    apply_custom_words, filter_transcription_output, trim_proxy_upload_audio,
};
use crate::groq_client;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::model::{
    groq_api_model_name, is_cloud_model_id, EngineType, ModelInfo, ModelManager,
    DEFAULT_LOCAL_MODEL_ID,
};
use crate::settings::{
    get_settings, write_settings, AccessState, AppSettings, ModelUnloadTimeout, TrialState,
};
use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::time::{sleep, timeout};
use transcribe_rs::{
    engines::{
        moonshine::{
            ModelVariant, MoonshineEngine, MoonshineModelParams, MoonshineStreamingEngine,
            StreamingModelParams,
        },
        parakeet::{
            ParakeetEngine, ParakeetInferenceParams, ParakeetModelParams, TimestampGranularity,
        },
        sense_voice::{
            Language as SenseVoiceLanguage, SenseVoiceEngine, SenseVoiceInferenceParams,
            SenseVoiceModelParams,
        },
        whisper::{WhisperEngine, WhisperInferenceParams},
    },
    TranscriptionEngine,
};

#[derive(Clone, Debug, Serialize)]
pub struct ModelStateEvent {
    pub event_type: String,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub error: Option<String>,
}

enum LoadedEngine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetEngine),
    Moonshine(MoonshineEngine),
    MoonshineStreaming(MoonshineStreamingEngine),
    SenseVoice(SenseVoiceEngine),
}

const SAMPLE_RATE: usize = 16_000;
const CHUNK_SAMPLES: usize = SAMPLE_RATE * 10;
const CHUNK_OVERLAP_SAMPLES: usize = SAMPLE_RATE * 3 / 2; // 1.5s
const CHUNK_FORCE_WAIT_SAMPLES: usize = SAMPLE_RATE * 2; // 2s of additional speech
const CHUNK_POLL_INTERVAL: Duration = Duration::from_millis(500);
const CHUNK_WARMUP_DURATION: Duration = Duration::from_secs(10);
const STOP_IN_FLIGHT_WAIT: Duration = Duration::from_secs(4);
const MAX_TOKEN_OVERLAP: usize = 25;
const MODEL_LOADING_WAIT_TIMEOUT: Duration = Duration::from_secs(12);

struct IncrementalRuntime {
    stop_requested: AtomicBool,
    failed: AtomicBool,
    in_flight: AtomicBool,
    next_chunk_start: AtomicUsize,
    chunk_count: AtomicU64,
    assembled_raw: Mutex<String>,
}

impl IncrementalRuntime {
    fn new() -> Self {
        Self {
            stop_requested: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            in_flight: AtomicBool::new(false),
            next_chunk_start: AtomicUsize::new(0),
            chunk_count: AtomicU64::new(0),
            assembled_raw: Mutex::new(String::new()),
        }
    }
}

struct IncrementalSession {
    binding_id: String,
    runtime: Arc<IncrementalRuntime>,
    worker_handle: tauri::async_runtime::JoinHandle<()>,
}

fn normalized_silence_hallucination_text(text: &str) -> String {
    text.chars()
        .flat_map(|ch| ch.to_lowercase())
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
fn looks_like_network_error(error_message: &str) -> bool {
    let lower = error_message.to_ascii_lowercase();
    [
        "connection",
        "connect error",
        "dns",
        "lookup address",
        "timed out",
        "timeout",
        "network",
        "unreachable",
        "temporary failure",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn audio_levels(audio: &[f32]) -> Option<(f32, f32)> {
    if audio.is_empty() {
        return None;
    }

    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f32;

    for &sample in audio {
        let abs = sample.abs();
        peak = peak.max(abs);
        sum_squares += f64::from(sample) * f64::from(sample);
    }

    let rms = (sum_squares / audio.len() as f64).sqrt() as f32;
    Some((rms, peak))
}

fn is_effectively_silent(levels: (f32, f32)) -> bool {
    const MAX_SILENT_RMS: f32 = 0.0035;
    const MAX_SILENT_PEAK: f32 = 0.02;

    levels.0 <= MAX_SILENT_RMS && levels.1 <= MAX_SILENT_PEAK
}

fn should_suppress_silence_hallucination(levels: Option<(f32, f32)>, transcription: &str) -> bool {
    const SILENCE_HALLUCINATIONS: &[&str] =
        &["thank you", "thanks for watching", "thank you for watching"];

    let normalized = normalized_silence_hallucination_text(transcription);
    if !SILENCE_HALLUCINATIONS.contains(&normalized.as_str()) {
        return false;
    }

    let Some(levels) = levels else {
        return false;
    };

    is_effectively_silent(levels)
}

fn choose_local_fallback_model_id(
    available_models: Vec<ModelInfo>,
    preferred_local_model_id: Option<&str>,
) -> Option<String> {
    let mut local_models: Vec<_> = available_models
        .into_iter()
        .filter(|model| model.is_downloaded && !is_cloud_model_id(&model.id))
        .collect();

    if let Some(preferred_id) = preferred_local_model_id {
        if local_models.iter().any(|model| model.id == preferred_id) {
            return Some(preferred_id.to_string());
        }
    }

    if local_models
        .iter()
        .any(|model| model.id == DEFAULT_LOCAL_MODEL_ID)
    {
        return Some(DEFAULT_LOCAL_MODEL_ID.to_string());
    }

    if let Some(recommended) = local_models.iter().find(|model| model.is_recommended) {
        return Some(recommended.id.clone());
    }

    const PRIORITY_IDS: &[&str] = &[
        "parakeet-tdt-0.6b-v3",
        "small",
        "turbo",
        "medium",
        "large",
        "parakeet-tdt-0.6b-v2",
        "moonshine-tiny-streaming-en",
        "moonshine-small-streaming-en",
        "moonshine-medium-streaming-en",
        "sense-voice-int8",
        "moonshine-base",
    ];
    for priority_id in PRIORITY_IDS {
        if local_models.iter().any(|model| model.id == *priority_id) {
            return Some((*priority_id).to_string());
        }
    }

    local_models.sort_by(|a, b| a.id.cmp(&b.id));
    local_models.first().map(|model| model.id.clone())
}

fn normalize_stitch_token(token: &str) -> String {
    let trimmed = token.trim_matches(|c: char| !c.is_alphanumeric());
    if trimmed.is_empty() {
        token.trim().to_lowercase()
    } else {
        trimmed.to_lowercase()
    }
}

fn append_stitched_text(existing: &mut String, incoming: &str) {
    let incoming_trimmed = incoming.trim();
    if incoming_trimmed.is_empty() {
        return;
    }

    if existing.trim().is_empty() {
        *existing = incoming_trimmed.to_string();
        return;
    }

    let existing_tokens: Vec<&str> = existing.split_whitespace().collect();
    let incoming_tokens: Vec<&str> = incoming_trimmed.split_whitespace().collect();
    if existing_tokens.is_empty() || incoming_tokens.is_empty() {
        if !existing.ends_with(' ') {
            existing.push(' ');
        }
        existing.push_str(incoming_trimmed);
        return;
    }

    let max_overlap = existing_tokens
        .len()
        .min(incoming_tokens.len())
        .min(MAX_TOKEN_OVERLAP);
    let mut overlap = 0usize;

    for candidate in (1..=max_overlap).rev() {
        let existing_suffix = &existing_tokens[existing_tokens.len() - candidate..];
        let incoming_prefix = &incoming_tokens[..candidate];
        let matches = existing_suffix
            .iter()
            .zip(incoming_prefix.iter())
            .all(|(a, b)| normalize_stitch_token(a) == normalize_stitch_token(b));
        if matches {
            overlap = candidate;
            break;
        }
    }

    let remainder = incoming_tokens[overlap..].join(" ");
    if remainder.is_empty() {
        return;
    }

    if !existing.ends_with(' ') {
        existing.push(' ');
    }
    existing.push_str(&remainder);
}

#[derive(Clone)]
pub struct TranscriptionManager {
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    model_manager: Arc<ModelManager>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<AtomicU64>,
    shutdown_signal: Arc<AtomicBool>,
    watcher_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
    incremental_session: Arc<Mutex<Option<IncrementalSession>>>,
    cancel_requested: Arc<AtomicBool>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle, model_manager: Arc<ModelManager>) -> Result<Self> {
        let manager = Self {
            engine: Arc::new(Mutex::new(None)),
            model_manager,
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(AtomicU64::new(
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            )),
            shutdown_signal: Arc::new(AtomicBool::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            is_loading: Arc::new(Mutex::new(false)),
            loading_condvar: Arc::new(Condvar::new()),
            incremental_session: Arc::new(Mutex::new(None)),
            cancel_requested: Arc::new(AtomicBool::new(false)),
        };

        // Start the idle watcher
        {
            let app_handle_cloned = app_handle.clone();
            let manager_cloned = manager.clone();
            let shutdown_signal = manager.shutdown_signal.clone();
            let handle = thread::spawn(move || {
                while !shutdown_signal.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(10)); // Check every 10 seconds

                    // Check shutdown signal again after sleep
                    if shutdown_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    let settings = get_settings(&app_handle_cloned);
                    let timeout_seconds = settings.model_unload_timeout.to_seconds();

                    if let Some(limit_seconds) = timeout_seconds {
                        // Skip polling-based unloading for immediate timeout since it's handled directly in transcribe()
                        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately {
                            continue;
                        }

                        let last = manager_cloned.last_activity.load(Ordering::Relaxed);
                        let now_ms = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;

                        if now_ms.saturating_sub(last) > limit_seconds * 1000 {
                            // idle -> unload
                            if manager_cloned.is_model_loaded() {
                                let unload_start = std::time::Instant::now();
                                debug!("Starting to unload model due to inactivity");

                                if let Ok(()) = manager_cloned.unload_model() {
                                    let _ = app_handle_cloned.emit(
                                        "model-state-changed",
                                        ModelStateEvent {
                                            event_type: "unloaded".to_string(),
                                            model_id: None,
                                            model_name: None,
                                            error: None,
                                        },
                                    );
                                    let unload_duration = unload_start.elapsed();
                                    debug!(
                                        "Model unloaded due to inactivity (took {}ms)",
                                        unload_duration.as_millis()
                                    );
                                }
                            }
                        }
                    }
                }
                debug!("Idle watcher thread shutting down gracefully");
            });
            *manager.watcher_handle.lock().unwrap() = Some(handle);
        }

        Ok(manager)
    }

    /// Lock the engine mutex, recovering from poison if a previous transcription panicked.
    fn lock_engine(&self) -> MutexGuard<'_, Option<LoadedEngine>> {
        self.engine.lock().unwrap_or_else(|poisoned| {
            warn!("Engine mutex was poisoned by a previous panic, recovering");
            poisoned.into_inner()
        })
    }

    pub fn is_model_loaded(&self) -> bool {
        let engine = self.lock_engine();
        engine.is_some()
    }

    pub fn unload_model(&self) -> Result<()> {
        let unload_start = std::time::Instant::now();
        debug!("Starting to unload model");

        {
            let mut engine = self.lock_engine();
            if let Some(ref mut loaded_engine) = *engine {
                match loaded_engine {
                    LoadedEngine::Whisper(ref mut e) => e.unload_model(),
                    LoadedEngine::Parakeet(ref mut e) => e.unload_model(),
                    LoadedEngine::Moonshine(ref mut e) => e.unload_model(),
                    LoadedEngine::MoonshineStreaming(ref mut e) => e.unload_model(),
                    LoadedEngine::SenseVoice(ref mut e) => e.unload_model(),
                }
            }
            *engine = None; // Drop the engine to free memory
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = None;
        }

        // Emit unloaded event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );

        let unload_duration = unload_start.elapsed();
        debug!(
            "Model unloaded manually (took {}ms)",
            unload_duration.as_millis()
        );
        Ok(())
    }

    /// Unloads the model immediately if the setting is enabled and the model is loaded
    pub fn maybe_unload_immediately(&self, context: &str) {
        let settings = get_settings(&self.app_handle);
        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately
            && self.is_model_loaded()
        {
            info!("Immediately unloading model after {}", context);
            if let Err(e) = self.unload_model() {
                warn!("Failed to immediately unload model: {}", e);
            }
        }
    }

    fn resolve_byok_groq_api_key(&self) -> Option<String> {
        let settings = get_settings(&self.app_handle);
        match crate::byok_secrets::load_groq_api_key(&self.app_handle, &settings) {
            Ok(Some(key)) => {
                let key = key.trim();
                if !key.is_empty() {
                    return Some(key.to_string());
                }
            }
            Ok(None) => {}
            Err(error) => {
                warn!("Failed to load Groq BYOK secret from Stronghold: {}", error);
            }
        }

        None
    }

    fn sync_cloud_access_state(
        &self,
        trial_state: TrialState,
        access_state: AccessState,
        entitlement_state: crate::settings::EntitlementState,
    ) {
        let mut settings = get_settings(&self.app_handle);
        settings.anonymous_trial_state = trial_state;
        settings.access_state = access_state;
        settings.entitlement_state = entitlement_state;
        write_settings(&self.app_handle, settings);
    }

    async fn ensure_backend_access_state(&self) -> Result<AppSettings> {
        let settings = get_settings(&self.app_handle);
        if settings.install_token.trim().is_empty() {
            if let Err(error) = bootstrap_install_state(&self.app_handle).await {
                if matches!(
                    settings.access_state,
                    AccessState::Trialing | AccessState::Subscribed
                ) {
                    warn!(
                        "Backend bootstrap failed; continuing with cached access state for fallback eligibility: {}",
                        error
                    );
                    return Ok(settings);
                }

                return Err(anyhow::anyhow!(error));
            }
        } else {
            if let Err(error) = refresh_entitlement_state(&self.app_handle).await {
                if matches!(
                    settings.access_state,
                    AccessState::Trialing | AccessState::Subscribed
                ) {
                    warn!(
                        "Backend entitlement refresh failed; continuing with cached access state for fallback eligibility: {}",
                        error
                    );
                    return Ok(settings);
                }

                return Err(anyhow::anyhow!(error));
            }
        }

        Ok(get_settings(&self.app_handle))
    }

    async fn open_claim_flow(&self) -> Result<String> {
        let claim = request_claim_token(&self.app_handle)
            .await
            .map_err(|error| anyhow::anyhow!(error))?;
        if let Err(error) = self
            .app_handle
            .opener()
            .open_url(claim.claim_url, None::<String>)
        {
            warn!("Failed to open claim URL: {}", error);
        }

        Err(anyhow::anyhow!(
            "Your trial has ended. Finish sign-in and checkout in the browser to continue transcription."
        ))
    }

    fn select_local_fallback_model_id(
        &self,
        preferred_local_model_id: Option<&str>,
    ) -> Option<String> {
        choose_local_fallback_model_id(
            self.model_manager.get_available_models(),
            preferred_local_model_id,
        )
    }

    pub fn select_preferred_local_model_id(
        &self,
        preferred_local_model_id: Option<&str>,
    ) -> Option<String> {
        self.select_local_fallback_model_id(preferred_local_model_id)
    }

    fn transcribe_with_local_engine(
        &self,
        audio: Vec<f32>,
        settings: &AppSettings,
    ) -> Result<String> {
        // Perform transcription with the appropriate local engine.
        // We use catch_unwind to prevent engine panics from poisoning the mutex,
        // which would make the app hang indefinitely on subsequent operations.
        let result = {
            let mut engine_guard = self.lock_engine();

            // Take the engine out so we own it during transcription.
            // If the engine panics, we simply don't put it back (effectively unloading it)
            // instead of poisoning the mutex.
            let mut engine = match engine_guard.take() {
                Some(e) => e,
                None => {
                    return Err(anyhow::anyhow!(
                        "Model failed to load after auto-load attempt. Please check your model settings."
                    ));
                }
            };

            // Release the lock before transcribing — no mutex held during the engine call
            drop(engine_guard);

            let transcribe_result = catch_unwind(AssertUnwindSafe(
                || -> Result<transcribe_rs::TranscriptionResult> {
                    match &mut engine {
                        LoadedEngine::Whisper(whisper_engine) => {
                            let whisper_language = if settings.selected_language == "auto" {
                                None
                            } else {
                                let normalized = if settings.selected_language == "zh-Hans"
                                    || settings.selected_language == "zh-Hant"
                                {
                                    "zh".to_string()
                                } else {
                                    settings.selected_language.clone()
                                };
                                Some(normalized)
                            };

                            let params = WhisperInferenceParams {
                                language: whisper_language,
                                translate: settings.translate_to_english,
                                ..Default::default()
                            };

                            whisper_engine
                                .transcribe_samples(audio, Some(params))
                                .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))
                        }
                        LoadedEngine::Parakeet(parakeet_engine) => {
                            let params = ParakeetInferenceParams {
                                timestamp_granularity: TimestampGranularity::Segment,
                                ..Default::default()
                            };
                            parakeet_engine
                                .transcribe_samples(audio, Some(params))
                                .map_err(|e| {
                                    anyhow::anyhow!("Parakeet transcription failed: {}", e)
                                })
                        }
                        LoadedEngine::Moonshine(moonshine_engine) => moonshine_engine
                            .transcribe_samples(audio, None)
                            .map_err(|e| anyhow::anyhow!("Moonshine transcription failed: {}", e)),
                        LoadedEngine::MoonshineStreaming(streaming_engine) => streaming_engine
                            .transcribe_samples(audio, None)
                            .map_err(|e| {
                                anyhow::anyhow!("Moonshine streaming transcription failed: {}", e)
                            }),
                        LoadedEngine::SenseVoice(sense_voice_engine) => {
                            let language = match settings.selected_language.as_str() {
                                "zh" | "zh-Hans" | "zh-Hant" => SenseVoiceLanguage::Chinese,
                                "en" => SenseVoiceLanguage::English,
                                "ja" => SenseVoiceLanguage::Japanese,
                                "ko" => SenseVoiceLanguage::Korean,
                                "yue" => SenseVoiceLanguage::Cantonese,
                                _ => SenseVoiceLanguage::Auto,
                            };
                            let params = SenseVoiceInferenceParams {
                                language,
                                use_itn: true,
                            };
                            sense_voice_engine
                                .transcribe_samples(audio, Some(params))
                                .map_err(|e| {
                                    anyhow::anyhow!("SenseVoice transcription failed: {}", e)
                                })
                        }
                    }
                },
            ));

            match transcribe_result {
                Ok(inner_result) => {
                    // Success or normal error — put the engine back
                    let mut engine_guard = self.lock_engine();
                    *engine_guard = Some(engine);
                    inner_result?
                }
                Err(panic_payload) => {
                    // Engine panicked — do NOT put it back (it's in an unknown state).
                    // The engine is dropped here, effectively unloading it.
                    let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!(
                        "Transcription engine panicked: {}. Model has been unloaded.",
                        panic_msg
                    );

                    // Clear the model ID so it will be reloaded on next attempt
                    {
                        let mut current_model = self
                            .current_model_id
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        *current_model = None;
                    }

                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "unloaded".to_string(),
                            model_id: None,
                            model_name: None,
                            error: Some(format!("Engine panicked: {}", panic_msg)),
                        },
                    );

                    return Err(anyhow::anyhow!(
                        "Transcription engine panicked: {}. The model has been unloaded and will reload on next attempt.",
                        panic_msg
                    ));
                }
            }
        };

        Ok(result.text)
    }

    fn update_last_activity(&self) {
        self.last_activity.store(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            Ordering::Relaxed,
        );
    }

    fn wait_for_loading_if_needed(&self) {
        let wait_started = Instant::now();
        let mut is_loading = self.is_loading.lock().unwrap();
        while *is_loading {
            if self.cancel_requested.load(Ordering::Relaxed) {
                break;
            }
            if wait_started.elapsed() >= MODEL_LOADING_WAIT_TIMEOUT {
                warn!(
                    "Timed out waiting {}s for model loading; clearing loading flag to avoid deadlock",
                    MODEL_LOADING_WAIT_TIMEOUT.as_secs()
                );
                *is_loading = false;
                self.loading_condvar.notify_all();
                break;
            }
            let (guard, _) = self
                .loading_condvar
                .wait_timeout(is_loading, Duration::from_millis(25))
                .unwrap();
            is_loading = guard;
        }
    }

    fn apply_transcription_filters(
        &self,
        raw_transcription: String,
        settings: &AppSettings,
    ) -> String {
        let corrected_result = if !settings.custom_words.is_empty() {
            apply_custom_words(
                &raw_transcription,
                &settings.custom_words,
                settings.word_correction_threshold,
            )
        } else {
            raw_transcription
        };

        filter_transcription_output(&corrected_result)
    }

    fn transcribe_raw_local_with_settings(
        &self,
        audio: Vec<f32>,
        settings: &AppSettings,
    ) -> Result<String> {
        self.update_last_activity();

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        if audio.is_empty() {
            return Ok(String::new());
        }

        self.wait_for_loading_if_needed();

        let engine_guard = self.lock_engine();
        if engine_guard.is_none() {
            return Err(anyhow::anyhow!("Model is not loaded for transcription."));
        }
        drop(engine_guard);

        self.transcribe_with_local_engine(audio, settings)
    }

    async fn transcribe_raw_local_with_settings_async(
        &self,
        audio: Vec<f32>,
        settings: &AppSettings,
    ) -> Result<String> {
        let manager = self.clone();
        let settings_owned = settings.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            manager.transcribe_raw_local_with_settings(audio, &settings_owned)
        })
        .await
        {
            Ok(result) => result,
            Err(join_err) => Err(anyhow::anyhow!(
                "Local transcription task failed to join: {}",
                join_err
            )),
        }
    }

    pub async fn transcribe_local_file_with_settings(
        &self,
        audio: Vec<f32>,
        settings: &AppSettings,
    ) -> Result<String> {
        self.transcribe_raw_local_with_settings_async(audio, settings)
            .await
    }

    async fn transcribe_with_direct_groq(
        &self,
        model_id: &str,
        audio: Vec<f32>,
        settings: &AppSettings,
        allow_local_fallback_on_cloud_error: bool,
    ) -> Result<String> {
        let groq_model = groq_api_model_name(model_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown Groq model id: {}", model_id))?;
        let api_key = self
            .resolve_byok_groq_api_key()
            .ok_or_else(|| anyhow::anyhow!("Groq API key is required for hidden BYOK mode."))?;

        match groq_client::transcribe_samples_direct(
            &api_key,
            groq_model,
            &audio,
            &settings.selected_language,
            settings.translate_to_english,
        )
        .await
        {
            Ok(text) => Ok(text),
            Err(groq_error) => {
                if !allow_local_fallback_on_cloud_error {
                    return Err(anyhow::anyhow!(
                        "Groq transcription failed during incremental chunking: {}",
                        groq_error
                    ));
                }

                let fallback_local_model_id = self
                    .select_local_fallback_model_id(
                        self.get_current_model()
                            .filter(|id| !is_cloud_model_id(id))
                            .or_else(|| {
                                if settings.selected_model.is_empty() {
                                    None
                                } else {
                                    Some(settings.selected_model.clone())
                                }
                            })
                            .as_deref(),
                    )
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "Groq transcription failed: {}. No downloaded local model available for fallback.",
                            groq_error
                        )
                    })?;

                let local_engine_loaded = {
                    let engine_guard = self.lock_engine();
                    engine_guard.is_some()
                };
                let current_model = self.get_current_model();
                if current_model.as_deref() != Some(fallback_local_model_id.as_str())
                    || !local_engine_loaded
                {
                    warn!(
                        "Switching transcription to local fallback model '{}' after Groq failure",
                        fallback_local_model_id
                    );
                    self.load_model(&fallback_local_model_id).map_err(|load_error| {
                        anyhow::anyhow!(
                            "Groq transcription failed: {}. Local fallback model '{}' failed to load: {}",
                            groq_error,
                            fallback_local_model_id,
                            load_error
                        )
                    })?;
                }

                self.transcribe_raw_local_with_settings_async(audio, settings)
                    .await
            }
        }
    }

    async fn transcribe_with_proxy_groq(
        &self,
        model_id: &str,
        audio: Vec<f32>,
        settings: &AppSettings,
        allow_local_fallback_on_cloud_error: bool,
    ) -> Result<String> {
        let access = self.ensure_backend_access_state().await?;

        if access.access_state == AccessState::Blocked
            && access.anonymous_trial_state != TrialState::New
        {
            return self.open_claim_flow().await;
        }

        let groq_model = groq_api_model_name(model_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown Groq model id: {}", model_id))?;
        let trimmed_audio = trim_proxy_upload_audio(&audio);

        if trimmed_audio.is_empty() {
            info!(
                "Skipping proxy transcription after trimming produced no uploadable audio ({} samples)",
                audio.len()
            );
            self.maybe_unload_immediately("trimmed proxy audio");
            return Ok(String::new());
        }

        if trimmed_audio.len() != audio.len() {
            debug!(
                "Trimmed proxy upload audio from {} to {} samples",
                audio.len(),
                trimmed_audio.len()
            );
        }

        match groq_client::transcribe_samples(
            access.install_token.trim(),
            groq_model,
            &trimmed_audio,
            &settings.selected_language,
            settings.translate_to_english,
        )
        .await
        {
            Ok(result) => {
                self.sync_cloud_access_state(
                    result.trial_state,
                    result.access_state,
                    result.entitlement_state,
                );
                Ok(result.text)
            }
            Err(error) => {
                if error.is_blocked() && access.anonymous_trial_state != TrialState::New {
                    return self.open_claim_flow().await;
                }

                if error.is_retryable()
                    && allow_local_fallback_on_cloud_error
                    && matches!(
                        access.access_state,
                        AccessState::Trialing | AccessState::Subscribed
                    )
                {
                    let fallback_local_model_id = self
                        .select_local_fallback_model_id(
                            self.get_current_model()
                                .filter(|id| !is_cloud_model_id(id))
                                .or_else(|| {
                                    if settings.selected_model.is_empty() {
                                        None
                                    } else {
                                        Some(settings.selected_model.clone())
                                    }
                                })
                                .as_deref(),
                        )
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "Backend transcription failed: {}. No downloaded local model available for fallback.",
                                error.to_message()
                            )
                        })?;

                    let local_engine_loaded = {
                        let engine_guard = self.lock_engine();
                        engine_guard.is_some()
                    };
                    let current_model = self.get_current_model();
                    if current_model.as_deref() != Some(fallback_local_model_id.as_str())
                        || !local_engine_loaded
                    {
                        warn!(
                            "Switching transcription to local fallback model '{}' after backend proxy failure",
                            fallback_local_model_id
                        );
                        self.load_model(&fallback_local_model_id).map_err(|load_error| {
                            anyhow::anyhow!(
                                "Backend transcription failed: {}. Local fallback model '{}' failed to load: {}",
                                error.to_message(),
                                fallback_local_model_id,
                                load_error
                            )
                        })?;
                    }

                    return self
                        .transcribe_raw_local_with_settings_async(audio, settings)
                        .await;
                }

                Err(anyhow::anyhow!(error.to_message()))
            }
        }
    }

    async fn transcribe_raw_with_settings(
        &self,
        audio: Vec<f32>,
        settings: &AppSettings,
        allow_local_fallback_on_cloud_error: bool,
    ) -> Result<String> {
        self.update_last_activity();

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        if audio.is_empty() {
            return Ok(String::new());
        }

        let selected_model_id = if settings.selected_model.is_empty() {
            None
        } else {
            Some(settings.selected_model.clone())
        };
        let selected_model_is_cloud = selected_model_id
            .as_deref()
            .map(is_cloud_model_id)
            .unwrap_or(false);

        // If settings explicitly select a cloud model, always start with cloud.
        // This allows cloud-first behavior even if a local fallback model is loaded.
        let active_model_id = if selected_model_is_cloud {
            selected_model_id.clone()
        } else {
            self.get_current_model()
                .filter(|id| !id.is_empty())
                .or_else(|| selected_model_id.clone())
        };

        let is_cloud_model = active_model_id
            .as_deref()
            .map(is_cloud_model_id)
            .unwrap_or(false);

        if !is_cloud_model {
            self.transcribe_raw_local_with_settings_async(audio, settings)
                .await
        } else {
            let model_id = active_model_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("No cloud model selected for transcription."))?;

            if let Some(_) = self.resolve_byok_groq_api_key() {
                debug!(
                    "Using direct Groq routing for cloud transcription because a local Groq key is present"
                );
                return self
                    .transcribe_with_direct_groq(
                        model_id,
                        audio,
                        settings,
                        allow_local_fallback_on_cloud_error,
                    )
                    .await;
            }

            self.transcribe_with_proxy_groq(
                model_id,
                audio,
                settings,
                allow_local_fallback_on_cloud_error,
            )
            .await
        }
    }

    pub fn load_model(&self, model_id: &str) -> Result<()> {
        let load_start = std::time::Instant::now();
        debug!("Starting to load model: {}", model_id);

        // Emit loading started event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: None,
                error: None,
            },
        );

        let model_info = self
            .model_manager
            .get_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        if is_cloud_model_id(model_id) {
            {
                let mut engine = self.engine.lock().unwrap();
                *engine = None;
            }
            {
                let mut current_model = self.current_model_id.lock().unwrap();
                *current_model = Some(model_id.to_string());
            }

            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_completed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: None,
                },
            );

            debug!("Cloud model selected: {}", model_id);
            return Ok(());
        }

        if !model_info.is_downloaded {
            let error_msg = "Model not downloaded";
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: Some(error_msg.to_string()),
                },
            );
            return Err(anyhow::anyhow!(error_msg));
        }

        let model_path = self.model_manager.get_model_path(model_id)?;

        // Create appropriate engine based on model type
        let loaded_engine = match model_info.engine_type {
            EngineType::Whisper => {
                let mut engine = WhisperEngine::new();
                engine.load_model(&model_path).map_err(|e| {
                    let error_msg = format!("Failed to load whisper model {}: {}", model_id, e);
                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "loading_failed".to_string(),
                            model_id: Some(model_id.to_string()),
                            model_name: Some(model_info.name.clone()),
                            error: Some(error_msg.clone()),
                        },
                    );
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Whisper(engine)
            }
            EngineType::Parakeet => {
                let mut engine = ParakeetEngine::new();
                engine
                    .load_model_with_params(&model_path, ParakeetModelParams::int8())
                    .map_err(|e| {
                        let error_msg =
                            format!("Failed to load parakeet model {}: {}", model_id, e);
                        let _ = self.app_handle.emit(
                            "model-state-changed",
                            ModelStateEvent {
                                event_type: "loading_failed".to_string(),
                                model_id: Some(model_id.to_string()),
                                model_name: Some(model_info.name.clone()),
                                error: Some(error_msg.clone()),
                            },
                        );
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::Parakeet(engine)
            }
            EngineType::Moonshine => {
                let mut engine = MoonshineEngine::new();
                engine
                    .load_model_with_params(
                        &model_path,
                        MoonshineModelParams::variant(ModelVariant::Base),
                    )
                    .map_err(|e| {
                        let error_msg =
                            format!("Failed to load moonshine model {}: {}", model_id, e);
                        let _ = self.app_handle.emit(
                            "model-state-changed",
                            ModelStateEvent {
                                event_type: "loading_failed".to_string(),
                                model_id: Some(model_id.to_string()),
                                model_name: Some(model_info.name.clone()),
                                error: Some(error_msg.clone()),
                            },
                        );
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::Moonshine(engine)
            }
            EngineType::MoonshineStreaming => {
                let mut engine = MoonshineStreamingEngine::new();
                engine
                    .load_model_with_params(&model_path, StreamingModelParams::default())
                    .map_err(|e| {
                        let error_msg = format!(
                            "Failed to load moonshine streaming model {}: {}",
                            model_id, e
                        );
                        let _ = self.app_handle.emit(
                            "model-state-changed",
                            ModelStateEvent {
                                event_type: "loading_failed".to_string(),
                                model_id: Some(model_id.to_string()),
                                model_name: Some(model_info.name.clone()),
                                error: Some(error_msg.clone()),
                            },
                        );
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::MoonshineStreaming(engine)
            }
            EngineType::SenseVoice => {
                let mut engine = SenseVoiceEngine::new();
                engine
                    .load_model_with_params(&model_path, SenseVoiceModelParams::int8())
                    .map_err(|e| {
                        let error_msg =
                            format!("Failed to load SenseVoice model {}: {}", model_id, e);
                        let _ = self.app_handle.emit(
                            "model-state-changed",
                            ModelStateEvent {
                                event_type: "loading_failed".to_string(),
                                model_id: Some(model_id.to_string()),
                                model_name: Some(model_info.name.clone()),
                                error: Some(error_msg.clone()),
                            },
                        );
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::SenseVoice(engine)
            }
        };

        // Update the current engine and model ID
        {
            let mut engine = self.lock_engine();
            *engine = Some(loaded_engine);
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = Some(model_id.to_string());
        }

        // Emit loading completed event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(model_info.name.clone()),
                error: None,
            },
        );

        let load_duration = load_start.elapsed();
        debug!(
            "Successfully loaded transcription model: {} (took {}ms)",
            model_id,
            load_duration.as_millis()
        );
        Ok(())
    }

    /// Kicks off the model loading in a background thread if it's not already loaded
    pub fn initiate_model_load(&self) {
        let mut is_loading = self.is_loading.lock().unwrap();
        if *is_loading || self.is_model_loaded() {
            return;
        }

        *is_loading = true;
        let is_loading_flag = Arc::clone(&self.is_loading);
        let loading_condvar = Arc::clone(&self.loading_condvar);
        let self_clone = self.clone();
        thread::spawn(move || {
            struct LoadingStateGuard {
                is_loading: Arc<Mutex<bool>>,
                loading_condvar: Arc<Condvar>,
            }

            impl Drop for LoadingStateGuard {
                fn drop(&mut self) {
                    let mut is_loading = self.is_loading.lock().unwrap();
                    *is_loading = false;
                    self.loading_condvar.notify_all();
                }
            }

            let _loading_guard = LoadingStateGuard {
                is_loading: is_loading_flag,
                loading_condvar,
            };

            let settings = get_settings(&self_clone.app_handle);
            let model_id = settings.selected_model.clone();
            let load_result = catch_unwind(AssertUnwindSafe(|| self_clone.load_model(&model_id)));

            match load_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => error!("Failed to load model '{}': {}", model_id, e),
                Err(panic_payload) => {
                    let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!("Model loading panicked for '{}': {}", model_id, panic_msg);
                }
            }
        });
    }

    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.current_model_id.lock().unwrap();
        current_model.clone()
    }

    pub fn start_incremental_session(
        &self,
        binding_id: &str,
        audio_manager: Arc<AudioRecordingManager>,
    ) -> Result<()> {
        self.clear_cancel_request();

        let settings = get_settings(&self.app_handle);
        if !settings.incremental_transcription_enabled {
            return Ok(());
        }

        if settings.translate_to_english {
            debug!(
                "Skipping incremental session for binding '{}' because translate_to_english is enabled",
                binding_id
            );
            return Ok(());
        }

        let active_model_id = if settings.selected_model.is_empty() {
            self.get_current_model().unwrap_or_default()
        } else {
            settings.selected_model.clone()
        };
        if active_model_id.is_empty() || !is_cloud_model_id(&active_model_id) {
            debug!(
                "Skipping incremental session for binding '{}' because active model '{}' is not cloud",
                binding_id, active_model_id
            );
            return Ok(());
        }

        let runtime = Arc::new(IncrementalRuntime::new());
        let binding = binding_id.to_string();
        let manager_clone = self.clone();
        let runtime_clone = runtime.clone();
        let worker_binding = binding.clone();
        let worker_handle = tauri::async_runtime::spawn(async move {
            manager_clone
                .run_incremental_worker(worker_binding, audio_manager, runtime_clone)
                .await;
        });

        let mut guard = self.incremental_session.lock().unwrap();
        if let Some(previous) = guard.take() {
            previous
                .runtime
                .stop_requested
                .store(true, Ordering::Relaxed);
            previous.worker_handle.abort();
        }
        *guard = Some(IncrementalSession {
            binding_id: binding,
            runtime,
            worker_handle,
        });

        Ok(())
    }

    async fn run_incremental_worker(
        &self,
        binding_id: String,
        audio_manager: Arc<AudioRecordingManager>,
        runtime: Arc<IncrementalRuntime>,
    ) {
        let started_at = Instant::now();
        let mut speech_buffer = Vec::<f32>::new();
        let mut saw_pause = false;

        loop {
            if runtime.stop_requested.load(Ordering::Relaxed)
                || runtime.failed.load(Ordering::Relaxed)
                || self.cancel_requested.load(Ordering::Relaxed)
            {
                break;
            }

            if started_at.elapsed() < CHUNK_WARMUP_DURATION {
                sleep(Duration::from_millis(200)).await;
                continue;
            }

            let drained = audio_manager.drain_recording_delta(&binding_id);
            let mut made_progress = false;

            if let Some(delta) = drained {
                if !delta.samples.is_empty() {
                    speech_buffer.extend_from_slice(&delta.samples);
                    made_progress = true;
                }
                if delta.saw_pause {
                    saw_pause = true;
                }
            }

            'chunking: loop {
                let next_start = runtime.next_chunk_start.load(Ordering::Relaxed);
                let available = speech_buffer.len().saturating_sub(next_start);
                if available < CHUNK_SAMPLES {
                    break;
                }

                let extra_after_min = available - CHUNK_SAMPLES;
                if !saw_pause && extra_after_min < CHUNK_FORCE_WAIT_SAMPLES {
                    break;
                }

                let chunk_end = next_start + CHUNK_SAMPLES;
                let chunk_start = next_start.saturating_sub(CHUNK_OVERLAP_SAMPLES);
                let chunk_samples = speech_buffer[chunk_start..chunk_end].to_vec();

                runtime.in_flight.store(true, Ordering::Relaxed);
                let chunk_st = Instant::now();
                let settings = get_settings(&self.app_handle);
                let selected_model_id = if settings.selected_model.is_empty() {
                    None
                } else {
                    Some(settings.selected_model.clone())
                };
                let selected_model_is_cloud = selected_model_id
                    .as_deref()
                    .map(is_cloud_model_id)
                    .unwrap_or(false);
                let active_model_id = if selected_model_is_cloud {
                    selected_model_id
                } else {
                    self.get_current_model()
                        .filter(|id| !id.is_empty())
                        .or_else(|| {
                            if settings.selected_model.is_empty() {
                                None
                            } else {
                                Some(settings.selected_model.clone())
                            }
                        })
                };
                let is_cloud_model = active_model_id
                    .as_deref()
                    .map(is_cloud_model_id)
                    .unwrap_or(false);
                let chunk_result = if is_cloud_model {
                    self.transcribe_raw_with_settings(chunk_samples, &settings, false)
                        .await
                } else {
                    let manager = self.clone();
                    let settings_for_chunk = settings.clone();
                    match tauri::async_runtime::spawn_blocking(move || {
                        manager
                            .transcribe_raw_local_with_settings(chunk_samples, &settings_for_chunk)
                    })
                    .await
                    {
                        Ok(result) => result,
                        Err(join_err) => Err(anyhow::anyhow!(
                            "Incremental local chunk task failed to join: {}",
                            join_err
                        )),
                    }
                };
                runtime.in_flight.store(false, Ordering::Relaxed);

                match chunk_result {
                    Ok(chunk_text) => {
                        if self.cancel_requested.load(Ordering::Relaxed) {
                            break 'chunking;
                        }
                        if !runtime.stop_requested.load(Ordering::Relaxed) {
                            let mut assembled = runtime.assembled_raw.lock().unwrap();
                            append_stitched_text(&mut assembled, &chunk_text);
                            runtime.next_chunk_start.store(chunk_end, Ordering::Relaxed);
                            let count = runtime.chunk_count.fetch_add(1, Ordering::Relaxed) + 1;
                            debug!(
                                "Incremental chunk {} completed in {}ms (speech_len={} samples)",
                                count,
                                chunk_st.elapsed().as_millis(),
                                chunk_end
                            );
                        }
                        saw_pause = false;
                        made_progress = true;
                    }
                    Err(err) => {
                        runtime.failed.store(true, Ordering::Relaxed);
                        warn!(
                            "Incremental chunk transcription failed for binding '{}': {}",
                            binding_id, err
                        );
                        break 'chunking;
                    }
                }
            }

            if runtime.failed.load(Ordering::Relaxed) {
                break;
            }

            if !made_progress {
                sleep(CHUNK_POLL_INTERVAL).await;
            }
        }
    }

    pub async fn finish_incremental_session(
        &self,
        binding_id: &str,
        full_samples: &[f32],
    ) -> Result<String> {
        let session = {
            let mut guard = self.incremental_session.lock().unwrap();
            let Some(session) = guard.take() else {
                return Err(anyhow::anyhow!("No active incremental session"));
            };

            if session.binding_id != binding_id {
                *guard = Some(session);
                return Err(anyhow::anyhow!(
                    "Active incremental session belongs to a different binding"
                ));
            }
            session
        };

        session
            .runtime
            .stop_requested
            .store(true, Ordering::Relaxed);

        // Short utterances cannot produce a full 10s incremental chunk.
        // Skip worker join waiting and fall back to the regular full-pass path.
        if full_samples.len() < CHUNK_SAMPLES {
            session.worker_handle.abort();
            return Err(anyhow::anyhow!(
                "Not enough incremental progress for chunked finalization"
            ));
        }

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        let mut worker_handle = session.worker_handle;
        match timeout(STOP_IN_FLIGHT_WAIT, async { (&mut worker_handle).await }).await {
            Ok(join_result) => {
                if let Err(join_err) = join_result {
                    warn!("Incremental worker join error: {}", join_err);
                }
            }
            Err(_) => {
                warn!("Timed out waiting for incremental in-flight chunk; aborting worker");
                worker_handle.abort();
            }
        }

        if session.runtime.failed.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!(
                "Incremental chunking failed; using full-pass fallback"
            ));
        }

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        let next_chunk_start = session.runtime.next_chunk_start.load(Ordering::Relaxed);
        if full_samples.len() < CHUNK_SAMPLES || next_chunk_start == 0 {
            return Err(anyhow::anyhow!(
                "Not enough incremental progress for chunked finalization"
            ));
        }

        let tail_start = next_chunk_start.saturating_sub(CHUNK_OVERLAP_SAMPLES);
        let tail_audio = if tail_start < full_samples.len() {
            full_samples[tail_start..].to_vec()
        } else {
            Vec::new()
        };

        if !tail_audio.is_empty() {
            session.runtime.in_flight.store(true, Ordering::Relaxed);
            let tail_st = Instant::now();
            let settings = get_settings(&self.app_handle);
            let tail_result = self
                .transcribe_raw_with_settings(tail_audio, &settings, false)
                .await;
            session.runtime.in_flight.store(false, Ordering::Relaxed);

            match tail_result {
                Ok(tail_text) => {
                    if self.cancel_requested.load(Ordering::Relaxed) {
                        return Err(anyhow::anyhow!("Transcription cancelled"));
                    }
                    let mut assembled = session.runtime.assembled_raw.lock().unwrap();
                    append_stitched_text(&mut assembled, &tail_text);
                    debug!(
                        "Incremental tail processed in {}ms",
                        tail_st.elapsed().as_millis()
                    );
                }
                Err(err) => {
                    return Err(anyhow::anyhow!(
                        "Failed to transcribe incremental tail: {}",
                        err
                    ));
                }
            }
        }

        let raw = session.runtime.assembled_raw.lock().unwrap().clone();
        if raw.trim().is_empty() {
            return Err(anyhow::anyhow!(
                "Incremental assembly was empty; using full-pass fallback"
            ));
        }

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        let settings = get_settings(&self.app_handle);
        let final_result = self.apply_transcription_filters(raw, &settings);
        info!(
            "Incremental transcription finalized with {} chunk(s)",
            session.runtime.chunk_count.load(Ordering::Relaxed)
        );

        self.maybe_unload_immediately("incremental transcription");

        Ok(final_result)
    }

    pub fn signal_incremental_stop(&self, binding_id: &str) {
        let guard = self.incremental_session.lock().unwrap();
        if let Some(session) = guard.as_ref() {
            if session.binding_id == binding_id {
                session
                    .runtime
                    .stop_requested
                    .store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn has_incremental_session(&self, binding_id: &str) -> bool {
        let guard = self.incremental_session.lock().unwrap();
        guard
            .as_ref()
            .map(|session| session.binding_id == binding_id)
            .unwrap_or(false)
    }

    pub fn cancel_incremental_session(&self) {
        let mut guard = self.incremental_session.lock().unwrap();
        if let Some(session) = guard.take() {
            session
                .runtime
                .stop_requested
                .store(true, Ordering::Relaxed);
            session.worker_handle.abort();
            debug!("Cancelled incremental transcription session");
        }
    }

    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Relaxed);
        self.cancel_incremental_session();
    }

    pub fn clear_cancel_request(&self) {
        self.cancel_requested.store(false, Ordering::Relaxed);
    }

    pub fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Relaxed)
    }

    pub async fn transcribe(&self, audio: Vec<f32>) -> Result<String> {
        self.update_last_activity();

        let st = std::time::Instant::now();

        debug!("Audio vector length: {}", audio.len());

        if audio.is_empty() {
            debug!("Empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok(String::new());
        }

        let levels = audio_levels(&audio);
        if levels.is_some_and(is_effectively_silent) {
            info!("Skipping transcription for effectively silent audio");
            self.maybe_unload_immediately("silent audio");
            return Ok(String::new());
        }

        if self.cancel_requested.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("Transcription cancelled"));
        }

        let settings = get_settings(&self.app_handle);
        let raw_transcription = self
            .transcribe_raw_with_settings(audio, &settings, true)
            .await?;
        let mut filtered_result = self.apply_transcription_filters(raw_transcription, &settings);
        if should_suppress_silence_hallucination(levels, &filtered_result) {
            info!(
                "Suppressing likely silence hallucination for near-silent audio: {}",
                filtered_result
            );
            filtered_result.clear();
        }

        let et = std::time::Instant::now();
        let translation_note = if settings.translate_to_english {
            " (translated)"
        } else {
            ""
        };
        info!(
            "Transcription completed in {}ms{}",
            (et - st).as_millis(),
            translation_note
        );

        let final_result = filtered_result;

        if final_result.is_empty() {
            info!("Transcription result is empty");
        } else {
            info!("Transcription result: {}", final_result);
        }

        self.maybe_unload_immediately("transcription");

        Ok(final_result)
    }
}

impl Drop for TranscriptionManager {
    fn drop(&mut self) {
        // This manager is cheaply cloned for worker threads. Only the last live
        // instance should perform global shutdown of shared background state.
        if Arc::strong_count(&self.shutdown_signal) > 1 {
            debug!("Skipping TranscriptionManager shutdown for non-final clone drop");
            return;
        }

        debug!("Shutting down TranscriptionManager");

        self.cancel_incremental_session();

        // Signal the watcher thread to shutdown
        self.shutdown_signal.store(true, Ordering::Relaxed);

        // Wait for the thread to finish gracefully
        if let Some(handle) = self.watcher_handle.lock().unwrap().take() {
            if let Err(e) = handle.join() {
                warn!("Failed to join idle watcher thread: {:?}", e);
            } else {
                debug!("Idle watcher thread joined successfully");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::Duration;

    fn app_support_dir() -> PathBuf {
        PathBuf::from(
            std::env::var("HOME").expect("HOME must be set for local transcription tests"),
        )
        .join("Library/Application Support/com.pais.uttr")
    }

    fn newest_recording_path(recordings_dir: &Path) -> Option<PathBuf> {
        let mut recordings: Vec<_> = fs::read_dir(recordings_dir)
            .ok()?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("wav"))
            .collect();
        recordings.sort_by_key(|path| {
            fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });
        recordings.pop()
    }

    fn load_wav_samples(path: &Path) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("failed to open wav recording");
        let spec = reader.spec();
        match spec.sample_format {
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .map(|sample| sample.expect("invalid float sample"))
                .collect(),
            hound::SampleFormat::Int => {
                let max_value = (1_i64 << (spec.bits_per_sample.saturating_sub(1) as u32)) as f32;
                reader
                    .samples::<i32>()
                    .map(|sample| sample.expect("invalid int sample") as f32 / max_value)
                    .collect()
            }
        }
    }

    fn model(id: &str, is_downloaded: bool, is_recommended: bool) -> ModelInfo {
        ModelInfo {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            filename: String::new(),
            url: None,
            size_mb: 0,
            is_downloaded,
            is_downloading: false,
            partial_size: 0,
            is_directory: false,
            engine_type: EngineType::Whisper,
            accuracy_score: 0.0,
            speed_score: 0.0,
            supports_translation: true,
            is_recommended,
            supported_languages: vec![],
            is_custom: false,
        }
    }

    #[test]
    fn network_error_detection_matches_common_offline_failures() {
        assert!(looks_like_network_error(
            "Groq request failed: error sending request for url: connection refused"
        ));
        assert!(looks_like_network_error(
            "Groq request failed: dns error: failed to lookup address information"
        ));
        assert!(!looks_like_network_error(
            "Groq API request failed (401 Unauthorized): invalid api key"
        ));
    }

    #[test]
    fn local_fallback_prefers_requested_local_model_when_available() {
        let models = vec![model("small", true, false), model("turbo", true, false)];
        let picked = choose_local_fallback_model_id(models, Some("turbo"));
        assert_eq!(picked.as_deref(), Some("turbo"));
    }

    #[test]
    fn local_fallback_prefers_default_local_model_id() {
        let models = vec![
            model("small", true, false),
            model(DEFAULT_LOCAL_MODEL_ID, true, false),
            model("sense-voice-int8", true, true),
        ];
        let picked = choose_local_fallback_model_id(models, None);
        assert_eq!(picked.as_deref(), Some(DEFAULT_LOCAL_MODEL_ID));
    }

    #[test]
    fn local_fallback_prefers_recommended_then_priority_then_first_sorted() {
        let with_recommended = vec![
            model("small", true, false),
            model("medium", true, false),
            model("sensevoice", true, true),
        ];
        let picked_recommended = choose_local_fallback_model_id(with_recommended, None);
        assert_eq!(picked_recommended.as_deref(), Some("sensevoice"));

        let with_priority = vec![model("foo", true, false), model("small", true, false)];
        let picked_priority = choose_local_fallback_model_id(with_priority, None);
        assert_eq!(picked_priority.as_deref(), Some("small"));

        let sorted_fallback = vec![model("zeta", true, false), model("alpha", true, false)];
        let picked_sorted = choose_local_fallback_model_id(sorted_fallback, None);
        assert_eq!(picked_sorted.as_deref(), Some("alpha"));
    }

    #[test]
    fn local_fallback_ignores_cloud_and_not_downloaded_models() {
        let models = vec![
            model("groq-whisper-large-v3", true, false),
            model("small", false, false),
        ];
        let picked = choose_local_fallback_model_id(models, None);
        assert!(picked.is_none());
    }

    #[test]
    fn stitcher_removes_repeated_boundary_words() {
        let mut assembled = "hello world from the meeting".to_string();
        append_stitched_text(&mut assembled, "from the meeting today");
        assert_eq!(assembled, "hello world from the meeting today");
    }

    #[test]
    fn stitcher_handles_case_and_punctuation_at_boundary() {
        let mut assembled = "Thanks for joining,".to_string();
        append_stitched_text(&mut assembled, "joining today everyone");
        assert_eq!(assembled, "Thanks for joining, today everyone");
    }

    #[test]
    fn stitcher_appends_without_overlap() {
        let mut assembled = "alpha beta".to_string();
        append_stitched_text(&mut assembled, "gamma delta");
        assert_eq!(assembled, "alpha beta gamma delta");
    }

    #[test]
    fn silence_hallucination_detection_normalizes_punctuation_and_case() {
        let quiet_levels = audio_levels(&[0.0, 0.0005, -0.0004, 0.0003, 0.0]);
        assert!(should_suppress_silence_hallucination(
            quiet_levels,
            "Thank you!"
        ));
    }

    #[test]
    fn silence_hallucination_detection_does_not_suppress_real_speech_levels() {
        let speech_levels = audio_levels(&[0.0, 0.08, -0.07, 0.06, -0.05, 0.04]);
        assert!(!should_suppress_silence_hallucination(
            speech_levels,
            "thank you"
        ));
    }

    #[test]
    #[ignore = "Uses locally downloaded models and recordings to reproduce transcription hangs"]
    fn parakeet_transcribes_latest_local_recording_within_timeout() {
        let app_dir = app_support_dir();
        let model_dir = app_dir.join("models/parakeet-tdt-0.6b-v3-int8");
        assert!(
            model_dir.exists(),
            "expected parakeet model at {}",
            model_dir.display()
        );

        let recordings_dir = app_dir.join("recordings");
        let recording_path = newest_recording_path(&recordings_dir)
            .expect("expected at least one local recording to reproduce against");
        let samples = load_wav_samples(&recording_path);
        assert!(
            !samples.is_empty(),
            "latest recording {} contained no samples",
            recording_path.display()
        );

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut engine = ParakeetEngine::new();
            let result = engine
                .load_model_with_params(&model_dir, ParakeetModelParams::int8())
                .and_then(|_| {
                    engine.transcribe_samples(
                        samples,
                        Some(ParakeetInferenceParams {
                            timestamp_granularity: TimestampGranularity::Segment,
                            ..Default::default()
                        }),
                    )
                })
                .map(|result| result.text)
                .map_err(|err| err.to_string());
            let _ = tx.send(result);
        });

        let transcription = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("parakeet transcription timed out");

        let text = transcription.expect("parakeet transcription failed");
        assert!(
            !text.trim().is_empty(),
            "parakeet transcription returned empty text for {}",
            recording_path.display()
        );
    }
}
