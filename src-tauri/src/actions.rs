use crate::access::{
    get_install_access_snapshot, install_access_allows_premium_features,
    premium_feature_access_message,
};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::{normalize_spoken_lists, normalize_spoken_punctuation};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::full_system_audio::{
    FullSystemAudioSessionManager, FullSystemSessionStopResult,
};
use crate::managers::history::HistoryManager;
use crate::managers::model::is_cloud_model_id;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{
    get_settings, AppSettings, CleaningPromptPreset, PostProcessProvider,
    APPLE_INTELLIGENCE_PROVIDER_ID, NUANCED_CLEANING_PROMPT, STRICT_CLEANING_PROMPT,
};
use crate::shortcut;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
};
use crate::TranscriptionCoordinator;
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::time::timeout;

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
struct FinishGuard(AppHandle);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
    }
}

/// Drop guard that always restores overlay/tray UI state when the
/// transcription task exits (success, error, or panic unwind).
struct UiResetGuard {
    app: AppHandle,
    enabled: bool,
}

impl UiResetGuard {
    fn new(app: AppHandle) -> Self {
        Self { app, enabled: true }
    }

    fn suppress(&mut self) {
        self.enabled = false;
    }
}

impl Drop for UiResetGuard {
    fn drop(&mut self) {
        if self.enabled {
            utils::hide_recording_overlay(&self.app);
            change_tray_icon(&self.app, TrayIconState::Idle);
        }
    }
}

/// Marks async task completion for the watchdog.
struct CompletionGuard(Arc<AtomicBool>);
impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
}

struct FullSystemTranscribeAction {
    post_process: bool,
}

const GROQ_PROVIDER_ID: &str = "groq";
const GROQ_MODEL_PREFERENCES: &[&str] = &[
    "openai/gpt-oss-20b",
    "qwen/qwen3-32b",
    "groq/compound-mini",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "groq/compound",
    "moonshotai/kimi-k2-instruct-0905",
    "moonshotai/kimi-k2-instruct",
    "llama-3.1-8b-instant",
];
const FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT: Duration = Duration::from_secs(45);
const FULL_PASS_TRANSCRIPTION_TIMEOUT_PER_TEN_MINUTES: Duration = Duration::from_secs(60);
const FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE: Duration = Duration::from_secs(15);
const POST_PROCESS_TIMEOUT_DEFAULT: Duration = Duration::from_secs(60);
const SHORT_UTTERANCE_SAMPLES: usize = 16_000 * 10;

static AUTO_SELECTED_MODEL_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub struct FinalizedTranscriptionOutput {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
}

fn select_preferred_groq_model(available_models: &[String]) -> Option<String> {
    for preferred in GROQ_MODEL_PREFERENCES {
        if let Some(found) = available_models
            .iter()
            .find(|model| model.as_str() == *preferred)
        {
            return Some(found.clone());
        }
    }

    // Skip clearly non-chat/text models when possible.
    available_models
        .iter()
        .find(|model| is_supported_post_process_model(model))
        .cloned()
        .or_else(|| available_models.first().cloned())
}

fn is_supported_post_process_model(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    !id.contains("whisper")
        && !id.contains("tts")
        && !id.contains("transcribe")
        && !id.contains("speech")
        && !id.contains("audio")
        && !id.contains("orpheus")
        && !id.contains("guard")
        && !id.contains("safeguard")
        && !id.contains("moderation")
        && !id.contains("embed")
}

async fn resolve_post_process_model(
    provider: &PostProcessProvider,
    settings: &AppSettings,
    api_key: &str,
) -> Option<String> {
    let configured = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();
    if !configured.trim().is_empty() {
        return Some(configured);
    }

    if provider.id != GROQ_PROVIDER_ID {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    if let Ok(cache) = AUTO_SELECTED_MODEL_CACHE.lock() {
        if let Some(model) = cache.get(&provider.id) {
            return Some(model.clone());
        }
    }

    let available_models =
        match crate::llm_client::fetch_models(provider, api_key.to_string()).await {
            Ok(models) if !models.is_empty() => models,
            Ok(_) => {
                debug!(
                    "Post-processing skipped because provider '{}' returned no available models",
                    provider.id
                );
                return None;
            }
            Err(err) => {
                debug!(
                "Post-processing skipped because models could not be fetched for provider '{}': {}",
                provider.id, err
            );
                return None;
            }
        };

    let selected = match select_preferred_groq_model(&available_models) {
        Some(model) => model,
        None => return None,
    };

    if let Ok(mut cache) = AUTO_SELECTED_MODEL_CACHE.lock() {
        cache.insert(provider.id.clone(), selected.clone());
    }

    debug!(
        "Auto-selected post-process model '{}' for provider '{}'",
        selected, provider.id
    );
    Some(selected)
}

async fn post_process_transcription(
    app_handle: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
) -> Option<String> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let api_key = if provider.id == "groq" {
        match crate::byok_secrets::load_groq_api_key(app_handle, settings) {
            Ok(Some(key)) => key,
            Ok(None) => String::new(),
            Err(error) => {
                warn!(
                    "Failed to load Groq BYOK secret from Stronghold for post-processing: {}",
                    error
                );
                String::new()
            }
        }
    } else {
        settings
            .post_process_api_keys
            .get(&provider.id)
            .cloned()
            .unwrap_or_default()
    };

    let model = match resolve_post_process_model(&provider, settings, &api_key).await {
        Some(model) => model,
        None => return None,
    };

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {}), cleaning prompt preset: {:?}",
        provider.id, model, settings.post_process_cleaning_prompt_preset
    );

    // Hardcoded user message template — injects the transcript for the model to fill
    let processed_prompt = format!("# Input\n{}\n\n# Output\n", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if !apple_intelligence::check_apple_intelligence_availability() {
                debug!("Apple Intelligence selected but not currently available on this device");
                return None;
            }

            let token_limit = model.trim().parse::<i32>().unwrap_or(0);
            return match apple_intelligence::process_text(&processed_prompt, token_limit) {
                Ok(result) => {
                    if result.trim().is_empty() {
                        debug!("Apple Intelligence returned an empty response");
                        None
                    } else {
                        debug!(
                            "Apple Intelligence post-processing succeeded. Output length: {} chars",
                            result.len()
                        );
                        Some(result)
                    }
                }
                Err(err) => {
                    error!("Apple Intelligence post-processing failed: {}", err);
                    None
                }
            };
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            debug!("Apple Intelligence provider selected on unsupported platform");
            return None;
        }
    }

    // Resolve system prompt from the selected preset
    let resolved_system_prompt = match settings.post_process_cleaning_prompt_preset {
        CleaningPromptPreset::Strict => Some(STRICT_CLEANING_PROMPT),
        CleaningPromptPreset::Nuanced => Some(NUANCED_CLEANING_PROMPT),
        CleaningPromptPreset::Custom => {
            if settings.post_process_system_prompt.trim().is_empty() {
                None
            } else {
                Some(settings.post_process_system_prompt.as_str())
            }
        }
    };

    // Send the chat completion request
    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        resolved_system_prompt,
    )
    .await
    {
        Ok(Some(content)) => {
            // Strip invisible Unicode characters that some LLMs (e.g., Qwen) may insert
            let content = content
                .replace('\u{200B}', "") // Zero-Width Space
                .replace('\u{200C}', "") // Zero-Width Non-Joiner
                .replace('\u{200D}', "") // Zero-Width Joiner
                .replace('\u{FEFF}', ""); // Byte Order Mark / Zero-Width No-Break Space
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some(content)
        }
        Ok(None) => {
            error!("LLM API response has no content");
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            None
        }
    }
}

async fn maybe_convert_chinese_variant(
    settings: &AppSettings,
    transcription: &str,
) -> Option<String> {
    // Check if language is set to Simplified or Traditional Chinese
    let is_simplified = settings.selected_language == "zh-Hans";
    let is_traditional = settings.selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("selected_language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        settings.selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2twp
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

pub async fn finalize_transcription_output(
    app_handle: &AppHandle,
    settings: &AppSettings,
    transcription: &str,
    post_process: bool,
) -> FinalizedTranscriptionOutput {
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;

    if let Some(converted_text) = maybe_convert_chinese_variant(settings, transcription).await {
        final_text = converted_text;
    }

    let post_process_timeout = if settings.post_process_timeout_secs > 0 {
        Duration::from_secs(settings.post_process_timeout_secs)
    } else {
        POST_PROCESS_TIMEOUT_DEFAULT
    };
    let processed = if post_process {
        match timeout(
            post_process_timeout,
            post_process_transcription(app_handle, settings, &final_text),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                warn!(
                    "Post-processing timed out after {}s; continuing with base transcription",
                    post_process_timeout.as_secs()
                );
                None
            }
        }
    } else {
        None
    };

    if let Some(processed_text) = processed {
        post_processed_text = Some(processed_text.clone());
        final_text = processed_text;
        post_process_prompt = Some(match settings.post_process_cleaning_prompt_preset {
            CleaningPromptPreset::Strict => STRICT_CLEANING_PROMPT.to_string(),
            CleaningPromptPreset::Nuanced => NUANCED_CLEANING_PROMPT.to_string(),
            CleaningPromptPreset::Custom => settings.post_process_system_prompt.clone(),
        });
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    if post_process {
        let normalized_punctuation = normalize_spoken_punctuation(&final_text);
        let normalized_lists = normalize_spoken_lists(&normalized_punctuation);
        if normalized_lists != final_text {
            final_text = normalized_lists;
            post_processed_text = Some(final_text.clone());
        }
    }

    FinalizedTranscriptionOutput {
        final_text,
        post_processed_text,
        post_process_prompt,
    }
}

async fn transcribe_full_pass_with_timeout(
    tm: &Arc<TranscriptionManager>,
    samples: Vec<f32>,
    source: Option<&str>,
    timeout_duration: Duration,
) -> Result<String, anyhow::Error> {
    match timeout(timeout_duration, tm.transcribe_with_source(samples, source)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "Transcription timed out after {}s",
            timeout_duration.as_secs()
        )),
    }
}

fn transcription_timeout_for_samples(sample_count: usize) -> Duration {
    if sample_count == 0 {
        return FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT;
    }

    let audio_seconds = (sample_count as u64).div_ceil(16_000);
    let ten_minute_blocks = audio_seconds.div_ceil(600).max(1);
    FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT
        + FULL_PASS_TRANSCRIPTION_TIMEOUT_PER_TEN_MINUTES
            .saturating_mul((ten_minute_blocks.saturating_sub(1)) as u32)
}

fn transcription_watchdog_delay(sample_count: usize) -> Duration {
    transcription_timeout_for_samples(sample_count) + FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE
}

fn transcription_source_for_binding(binding_id: &str) -> Option<&'static str> {
    match binding_id {
        "transcribe_full_system_audio" => Some("full_system_audio"),
        _ => None,
    }
}

async fn show_no_input_overlay_feedback(
    app: &AppHandle,
    include_processing: bool,
    overlay_epoch: u64,
) {
    const TRANSCRIBING_FEEDBACK_MS: u64 = 900;
    const PROCESSING_FEEDBACK_MS: u64 = 900;
    const ALERT_VISIBLE_MS: u64 = 2000;

    tokio::time::sleep(Duration::from_millis(TRANSCRIBING_FEEDBACK_MS)).await;
    if utils::current_overlay_session_epoch() != overlay_epoch {
        return;
    }

    if include_processing {
        show_processing_overlay(app);
        tokio::time::sleep(Duration::from_millis(PROCESSING_FEEDBACK_MS)).await;
        if utils::current_overlay_session_epoch() != overlay_epoch {
            return;
        }
    }

    utils::emit_overlay_alert(app, "no_input");
    tokio::time::sleep(Duration::from_millis(ALERT_VISIBLE_MS)).await;
    if utils::current_overlay_session_epoch() != overlay_epoch {
        return;
    }
}

fn spawn_no_input_overlay_feedback(app: &AppHandle, include_processing: bool) {
    let ah = app.clone();
    let overlay_epoch = utils::current_overlay_session_epoch();
    tauri::async_runtime::spawn(async move {
        show_no_input_overlay_feedback(&ah, include_processing, overlay_epoch).await;
        if utils::current_overlay_session_epoch() == overlay_epoch {
            utils::hide_recording_overlay(&ah);
            change_tray_icon(&ah, TrayIconState::Idle);
        }
    });
}

fn silent_audio_levels(samples: &[f32]) -> Option<(f32, f32)> {
    if samples.is_empty() {
        return None;
    }

    let mut sum_squares = 0.0f32;
    let mut peak = 0.0f32;

    for sample in samples {
        let amplitude = sample.abs();
        sum_squares += sample * sample;
        if amplitude > peak {
            peak = amplitude;
        }
    }

    let rms = (sum_squares / samples.len() as f32).sqrt();
    Some((rms, peak))
}

fn is_effectively_silent_audio(samples: &[f32]) -> bool {
    const MAX_SILENT_RMS: f32 = 0.0015;
    const MAX_SILENT_PEAK: f32 = 0.01;

    let Some((rms, peak)) = silent_audio_levels(samples) else {
        return true;
    };

    rms <= MAX_SILENT_RMS && peak <= MAX_SILENT_PEAK
}

fn should_use_incremental_transcription(settings: &AppSettings, tm: &TranscriptionManager) -> bool {
    let active_model_id = if settings.selected_model.is_empty() {
        tm.get_current_model().unwrap_or_default()
    } else {
        settings.selected_model.clone()
    };

    settings.incremental_transcription_enabled
        && !settings.translate_to_english
        && is_cloud_model_id(&active_model_id)
}

fn start_transcription_session(app: &AppHandle, binding_id: &str, started: bool) {
    if started {
        shortcut::register_cancel_shortcut(app);
    } else {
        utils::hide_recording_overlay(app);
        change_tray_icon(app, TrayIconState::Idle);
    }
    debug!(
        "Transcription session start completed for '{}' (started={})",
        binding_id, started
    );
}

fn handle_transcription_stop(
    app: &AppHandle,
    binding_id: &str,
    samples: Option<Vec<f32>>,
    recording_duration: Option<Duration>,
    post_process: bool,
    use_incremental: bool,
    tm: Arc<TranscriptionManager>,
    hm: Arc<HistoryManager>,
) {
    let ah = app.clone();
    let binding_id = binding_id.to_string();
    let task_completed = Arc::new(AtomicBool::new(false));
    let task_completed_for_worker = Arc::clone(&task_completed);
    let tm_for_worker = tm.clone();
    let recording_duration = recording_duration.unwrap_or_default();
    let transcription_watchdog = samples
        .as_ref()
        .map(|samples| transcription_watchdog_delay(samples.len()))
        .unwrap_or(FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT + FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE);

    let transcription_task = tauri::async_runtime::spawn(async move {
        let _guard = FinishGuard(ah.clone());
        let _completion_guard = CompletionGuard(task_completed_for_worker);
        let mut ui_guard = UiResetGuard::new(ah.clone());
        let binding_id = binding_id.clone();
        debug!(
            "Starting async transcription task for binding: {}",
            binding_id
        );

        let Some(samples) = samples else {
            warn!("No samples retrieved from recording stop");
            if recording_duration >= Duration::from_secs(1) {
                ui_guard.suppress();
                spawn_no_input_overlay_feedback(&ah, post_process);
            }
            return;
        };

        let stop_recording_time = Instant::now();
        debug!(
            "Recording stopped and samples retrieved in {:?}, sample count: {}",
            stop_recording_time.elapsed(),
            samples.len()
        );
        let transcription_timeout = transcription_timeout_for_samples(samples.len());

        if samples.is_empty() {
            if recording_duration >= Duration::from_secs(1) {
                ui_guard.suppress();
                spawn_no_input_overlay_feedback(&ah, post_process);
            } else {
                let settings = get_settings(&ah);
                let binding = settings
                    .bindings
                    .get(&binding_id)
                    .map(|b| b.current_binding.as_str())
                    .unwrap_or("");
                let message = if binding == "fn" {
                    "No audio captured. The Fn-only shortcut can be unreliable. Use a shortcut like Option+Space."
                } else {
                    "No audio captured. Hold the push-to-talk key a bit longer or choose a different shortcut."
                };
                warn!("{}", message);
                let _ = ah.emit("transcription-error", message.to_string());
                utils::hide_recording_overlay(&ah);
                change_tray_icon(&ah, TrayIconState::Idle);
            }
            return;
        }

        if recording_duration >= Duration::from_secs(1) {
            if let Some((rms, peak)) = silent_audio_levels(&samples) {
                debug!(
                    "Recording audio levels for '{}': duration_ms={}, rms={:.6}, peak={:.6}",
                    binding_id,
                    recording_duration.as_millis(),
                    rms,
                    peak
                );
            }
        }

        let suspected_no_input =
            recording_duration >= Duration::from_secs(1) && is_effectively_silent_audio(&samples);

        let transcription_time = Instant::now();
        let samples_clone = samples.clone();
        let has_incremental_progress =
            use_incremental && tm_for_worker.has_incremental_progress(&binding_id);
        let transcription_result = if use_incremental
            && samples.len() >= SHORT_UTTERANCE_SAMPLES
            && has_incremental_progress
        {
            match timeout(
                Duration::from_secs(6),
                tm_for_worker.finish_incremental_session(&binding_id, &samples),
            )
            .await
            {
                Ok(Ok(text)) => {
                    debug!(
                        "Incremental transcription finalized in {:?}",
                        transcription_time.elapsed()
                    );
                    Ok(text)
                }
                Ok(Err(incremental_err)) => {
                    warn!(
                        "Incremental path unavailable, falling back to full-pass transcription: {}",
                        incremental_err
                    );
                    tm_for_worker.cancel_incremental_session();
                    transcribe_full_pass_with_timeout(
                        &tm_for_worker,
                        samples,
                        transcription_source_for_binding(&binding_id),
                        transcription_timeout,
                    )
                    .await
                }
                Err(_) => {
                    warn!(
                        "Incremental finalization timed out; falling back to full-pass transcription"
                    );
                    tm_for_worker.cancel_incremental_session();
                    transcribe_full_pass_with_timeout(
                        &tm_for_worker,
                        samples,
                        transcription_source_for_binding(&binding_id),
                        transcription_timeout,
                    )
                    .await
                }
            }
        } else if samples.len() < SHORT_UTTERANCE_SAMPLES {
            if use_incremental {
                tm_for_worker.cancel_incremental_session();
            }
            debug!(
                "Using short-utterance fast path ({} samples)",
                samples.len()
            );
            transcribe_full_pass_with_timeout(
                &tm_for_worker,
                samples,
                transcription_source_for_binding(&binding_id),
                transcription_timeout,
            )
            .await
        } else {
            if use_incremental && !has_incremental_progress {
                debug!(
                    "Skipping incremental finalization because no chunk completed for binding '{}'",
                    binding_id
                );
                tm_for_worker.cancel_incremental_session();
            }
            transcribe_full_pass_with_timeout(
                &tm_for_worker,
                samples,
                transcription_source_for_binding(&binding_id),
                transcription_timeout,
            )
            .await
        };
        match transcription_result {
            Ok(transcription) => {
                if suspected_no_input && transcription.trim().is_empty() {
                    ui_guard.suppress();
                    spawn_no_input_overlay_feedback(&ah, post_process);
                    return;
                }
                if tm_for_worker.is_cancel_requested() {
                    debug!("Transcription was cancelled before output handling");
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                    return;
                }
                debug!(
                    "Transcription completed in {:?}: '{}'",
                    transcription_time.elapsed(),
                    transcription
                );
                if !transcription.is_empty() {
                    let settings = get_settings(&ah);
                    if post_process {
                        show_processing_overlay(&ah);
                    }
                    let finalized =
                        finalize_transcription_output(&ah, &settings, &transcription, post_process)
                            .await;
                    let final_text = finalized.final_text;
                    let post_processed_text = finalized.post_processed_text;
                    let post_process_prompt = finalized.post_process_prompt;

                    let hm_clone = Arc::clone(&hm);
                    let transcription_for_history = transcription.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = hm_clone
                            .save_transcription(
                                samples_clone,
                                transcription_for_history,
                                post_processed_text,
                                post_process_prompt,
                            )
                            .await
                        {
                            error!("Failed to save transcription to history: {}", e);
                        }
                    });

                    let ah_clone = ah.clone();
                    let paste_time = Instant::now();
                    ah.run_on_main_thread(move || {
                        let text_for_paste = final_text.clone();
                        match utils::paste(text_for_paste.clone(), ah_clone.clone()) {
                            Ok(()) => debug!(
                                "Text pasted successfully in {:?}",
                                paste_time.elapsed()
                            ),
                            Err(e) => {
                                error!("Failed to paste transcription: {}", e);
                                let _ = ah_clone.emit(
                                    "transcription-error",
                                    format!(
                                        "Transcription succeeded, but paste failed: {}",
                                        e
                                    ),
                                );
                                if let Err(copy_err) =
                                    ah_clone.clipboard().write_text(&text_for_paste)
                                {
                                    error!(
                                        "Failed to copy transcription to clipboard after paste error: {}",
                                        copy_err
                                    );
                                }
                            }
                        }
                        utils::hide_recording_overlay(&ah_clone);
                        change_tray_icon(&ah_clone, TrayIconState::Idle);
                    })
                    .unwrap_or_else(|e| {
                        error!("Failed to run paste on main thread: {:?}", e);
                        utils::hide_recording_overlay(&ah);
                        change_tray_icon(&ah, TrayIconState::Idle);
                    });
                } else {
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                }
            }
            Err(err) => {
                if suspected_no_input {
                    ui_guard.suppress();
                    spawn_no_input_overlay_feedback(&ah, post_process);
                    return;
                }
                if tm_for_worker.is_cancel_requested() {
                    debug!("Transcription task cancelled");
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                    return;
                }
                error!("Global Shortcut Transcription error: {}", err);
                let _ = ah.emit("transcription-error", err.to_string());
                utils::hide_recording_overlay(&ah);
                change_tray_icon(&ah, TrayIconState::Idle);
            }
        }
    });

    {
        let app_for_watchdog = app.clone();
        let tm_for_watchdog = tm.clone();
        let task_completed = Arc::clone(&task_completed);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(transcription_watchdog).await;
            if task_completed.load(Ordering::Relaxed) {
                return;
            }

            warn!(
                "Transcription watchdog fired after {}s; forcing cancellation and coordinator reset",
                transcription_watchdog.as_secs()
            );
            tm_for_watchdog.request_cancel();
            transcription_task.abort();
            utils::cancel_current_operation(&app_for_watchdog);
            let _ = app_for_watchdog.emit(
                "transcription-error",
                "Transcription timed out. Please try again.".to_string(),
            );
        });
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.clear_cancel_request();
        let settings = get_settings(app);
        let preload_model_id = if settings.selected_model.is_empty() {
            tm.get_current_model().unwrap_or_default()
        } else {
            settings.selected_model.clone()
        };
        let use_incremental = should_use_incremental_transcription(&settings, &tm);
        // Cloud models do not load a local engine, so skip preload
        // to avoid adding loading-wait overhead on short recordings.
        if preload_model_id.is_empty() || !is_cloud_model_id(&preload_model_id) {
            tm.initiate_model_load();
        } else {
            debug!(
                "Skipping preload for cloud model '{}' in hot path",
                preload_model_id
            );
        }

        let binding_id = binding_id.to_string();
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        let rm = app.state::<Arc<AudioRecordingManager>>();

        // Get the microphone mode to determine audio feedback timing
        let is_always_on = settings.always_on_microphone;
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_started = false;
        if is_always_on {
            // Always-on mode: Play audio feedback immediately, then apply mute after sound finishes
            debug!("Always-on mode: Playing audio feedback immediately");
            let rm_clone = Arc::clone(&rm);
            let app_clone = app.clone();
            // The blocking helper exits immediately if audio feedback is disabled,
            // so we can always reuse this thread to ensure mute happens right after playback.
            std::thread::spawn(move || {
                play_feedback_sound_blocking(&app_clone, SoundType::Start);
                rm_clone.apply_mute();
            });

            recording_started = rm.try_start_recording(&binding_id);
            debug!("Recording started: {}", recording_started);
        } else {
            // On-demand mode: Start recording first, then play audio feedback, then apply mute
            // This allows the microphone to be activated before playing the sound
            debug!("On-demand mode: Starting recording first, then audio feedback");
            let recording_start_time = Instant::now();
            if rm.try_start_recording(&binding_id) {
                recording_started = true;
                debug!("Recording started in {:?}", recording_start_time.elapsed());
                // Small delay to ensure microphone stream is active
                let app_clone = app.clone();
                let rm_clone = Arc::clone(&rm);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    debug!("Handling delayed audio feedback/mute sequence");
                    // Helper handles disabled audio feedback by returning early, so we reuse it
                    // to keep mute sequencing consistent in every mode.
                    play_feedback_sound_blocking(&app_clone, SoundType::Start);
                    rm_clone.apply_mute();
                });
            } else {
                debug!("Failed to start recording");
            }
        }

        tm.cancel_incremental_session();
        start_transcription_session(app, &binding_id, recording_started);
        if recording_started && use_incremental {
            if let Err(e) = tm.start_incremental_session(&binding_id, Arc::clone(&rm)) {
                warn!("Failed to start incremental transcription session: {}", e);
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        change_tray_icon(app, TrayIconState::Transcribing);
        show_transcribing_overlay(app);

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let settings = get_settings(app);
        // When post-processing is enabled in settings, apply it automatically for normal
        // transcription. The dedicated post-process hotkey still forces it on.
        let post_process = self.post_process || settings.post_process_enabled;
        let use_incremental = should_use_incremental_transcription(&settings, &tm);
        if use_incremental {
            tm.signal_incremental_stop(binding_id);
        }
        let recording_duration = rm.current_recording_duration(binding_id);
        let samples = rm.stop_recording(binding_id);
        handle_transcription_stop(
            app,
            binding_id,
            samples,
            recording_duration,
            post_process,
            use_incremental,
            tm,
            hm,
        );

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

impl ShortcutAction for FullSystemTranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let access = get_install_access_snapshot(app);
        if !install_access_allows_premium_features(&access) {
            let _ = app.emit(
                "transcription-error",
                premium_feature_access_message().to_string(),
            );
            return;
        }

        let start_time = Instant::now();
        debug!(
            "FullSystemTranscribeAction::start called for binding: {}",
            binding_id
        );

        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.clear_cancel_request();
        let settings = get_settings(app);
        let preload_model_id = if settings.selected_model.is_empty() {
            tm.get_current_model().unwrap_or_default()
        } else {
            settings.selected_model.clone()
        };
        if preload_model_id.is_empty() || !is_cloud_model_id(&preload_model_id) {
            tm.initiate_model_load();
        } else {
            debug!(
                "Skipping preload for cloud model '{}' in hot path",
                preload_model_id
            );
        }

        tm.cancel_incremental_session();
        let binding_id = binding_id.to_string();
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        let full_system_audio = app.state::<Arc<FullSystemAudioSessionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        let is_always_on = settings.always_on_microphone;
        debug!("Full-system mode - always_on: {}", is_always_on);

        let mut recording_started = false;
        let start_config = crate::full_system_audio_bridge::FullSystemAudioCaptureConfig::default();
        if is_always_on {
            let rm_clone = Arc::clone(&rm);
            let app_clone = app.clone();
            std::thread::spawn(move || {
                play_feedback_sound_blocking(&app_clone, SoundType::Start);
                rm_clone.apply_mute();
            });

            recording_started = full_system_audio
                .start_session(&binding_id, start_config)
                .started;
            debug!("Full-system recording started: {}", recording_started);
        } else {
            let recording_start_time = Instant::now();
            if full_system_audio
                .start_session(&binding_id, start_config)
                .started
            {
                recording_started = true;
                debug!(
                    "Full-system recording started in {:?}",
                    recording_start_time.elapsed()
                );
                let app_clone = app.clone();
                let rm_clone = Arc::clone(&rm);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    debug!("Handling delayed full-system audio feedback/mute sequence");
                    play_feedback_sound_blocking(&app_clone, SoundType::Start);
                    rm_clone.apply_mute();
                });
            } else {
                debug!("Failed to start full-system recording");
            }
        }

        start_transcription_session(app, binding_id.as_str(), recording_started);

        debug!(
            "FullSystemTranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!(
            "FullSystemTranscribeAction::stop called for binding: {}",
            binding_id
        );

        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());
        let full_system_audio = app.state::<Arc<FullSystemAudioSessionManager>>();

        change_tray_icon(app, TrayIconState::Transcribing);
        show_transcribing_overlay(app);
        rm.remove_mute();
        play_feedback_sound(app, SoundType::Stop);

        let stop_result: FullSystemSessionStopResult = full_system_audio.stop_session();
        handle_transcription_stop(
            app,
            binding_id,
            stop_result.transcription_samples,
            None,
            self.post_process || get_settings(app).post_process_enabled,
            false,
            tm,
            hm,
        );

        debug!(
            "FullSystemTranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Copy Last Transcript Action
struct CopyLastTranscriptAction;

impl ShortcutAction for CopyLastTranscriptAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        crate::tray::copy_last_transcript(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for one-shot actions.
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TranscribeAction { post_process: true }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_full_system_audio".to_string(),
        Arc::new(FullSystemTranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "copy_last_transcript".to_string(),
        Arc::new(CopyLastTranscriptAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod tests {
    use super::{
        is_supported_post_process_model, select_preferred_groq_model,
        transcription_timeout_for_samples, transcription_watchdog_delay, ACTION_MAP,
        FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT,
    };

    #[test]
    fn full_system_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("transcribe_full_system_audio"));
    }

    #[test]
    fn copy_last_transcript_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("copy_last_transcript"));
    }

    #[test]
    fn transcription_timeout_grows_for_long_recordings() {
        assert_eq!(
            transcription_timeout_for_samples(16_000 * 60 * 5),
            FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT
        );
        assert!(
            transcription_timeout_for_samples(16_000 * 60 * 11)
                > FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT
        );
        assert!(
            transcription_timeout_for_samples(16_000 * 60 * 31)
                > transcription_timeout_for_samples(16_000 * 60 * 11)
        );
    }

    #[test]
    fn transcription_watchdog_always_exceeds_timeout_budget() {
        let short_timeout = transcription_timeout_for_samples(16_000 * 60);
        let short_watchdog = transcription_watchdog_delay(16_000 * 60);
        assert!(short_watchdog > short_timeout);

        let long_timeout = transcription_timeout_for_samples(16_000 * 60 * 31);
        let long_watchdog = transcription_watchdog_delay(16_000 * 60 * 31);
        assert!(long_watchdog > long_timeout);
    }

    #[test]
    fn groq_selector_prefers_current_models_over_legacy_ids() {
        let available_models = vec![
            "llama-3.3-70b-versatile".to_string(),
            "llama-3.1-8b-instant".to_string(),
            "openai/gpt-oss-20b".to_string(),
            "mixtral-8x7b-32768".to_string(),
        ];

        assert_eq!(
            select_preferred_groq_model(&available_models).as_deref(),
            Some("openai/gpt-oss-20b")
        );
    }

    #[test]
    fn groq_selector_skips_guard_and_audio_models_in_fallback() {
        let available_models = vec![
            "whisper-large-v3-turbo".to_string(),
            "meta-llama/llama-prompt-guard-2-86m".to_string(),
            "canopylabs/orpheus-v1-english".to_string(),
            "openai/gpt-oss-safeguard-20b".to_string(),
            "qwen/qwen3-32b".to_string(),
        ];

        assert_eq!(
            select_preferred_groq_model(&available_models).as_deref(),
            Some("qwen/qwen3-32b")
        );
    }

    #[test]
    fn post_process_model_filter_rejects_guard_and_audio_ids() {
        assert!(!is_supported_post_process_model(
            "meta-llama/llama-prompt-guard-2-86m"
        ));
        assert!(!is_supported_post_process_model(
            "openai/gpt-oss-safeguard-20b"
        ));
        assert!(!is_supported_post_process_model(
            "canopylabs/orpheus-v1-english"
        ));
        assert!(is_supported_post_process_model("openai/gpt-oss-20b"));
    }
}
