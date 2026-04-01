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
struct UiResetGuard(AppHandle);
impl Drop for UiResetGuard {
    fn drop(&mut self) {
        utils::hide_recording_overlay(&self.0);
        change_tray_icon(&self.0, TrayIconState::Idle);
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
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
];
const FULL_PASS_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(20);
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
        .find(|model| {
            let id = model.to_ascii_lowercase();
            !id.contains("whisper")
                && !id.contains("tts")
                && !id.contains("transcribe")
                && !id.contains("speech")
        })
        .cloned()
        .or_else(|| available_models.first().cloned())
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
) -> Result<String, anyhow::Error> {
    match timeout(FULL_PASS_TRANSCRIPTION_TIMEOUT, tm.transcribe(samples)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "Transcription timed out after {}s",
            FULL_PASS_TRANSCRIPTION_TIMEOUT.as_secs()
        )),
    }
}

fn start_transcription_session(app: &AppHandle, binding_id: &str, started: bool) {
    let tm = app.state::<Arc<TranscriptionManager>>();
    if started {
        tm.cancel_incremental_session();
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
    post_process: bool,
    tm: Arc<TranscriptionManager>,
    hm: Arc<HistoryManager>,
) {
    let ah = app.clone();
    let binding_id = binding_id.to_string();
    let task_completed = Arc::new(AtomicBool::new(false));
    let task_completed_for_worker = Arc::clone(&task_completed);
    let tm_for_worker = tm.clone();

    let transcription_task = tauri::async_runtime::spawn(async move {
        let _guard = FinishGuard(ah.clone());
        let _completion_guard = CompletionGuard(task_completed_for_worker);
        let _ui_guard = UiResetGuard(ah.clone());
        let binding_id = binding_id.clone();
        debug!(
            "Starting async transcription task for binding: {}",
            binding_id
        );

        let Some(samples) = samples else {
            warn!("No samples retrieved from recording stop");
            utils::hide_recording_overlay(&ah);
            change_tray_icon(&ah, TrayIconState::Idle);
            return;
        };

        let stop_recording_time = Instant::now();
        debug!(
            "Recording stopped and samples retrieved in {:?}, sample count: {}",
            stop_recording_time.elapsed(),
            samples.len()
        );

        if samples.is_empty() {
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
            return;
        }

        let transcription_time = Instant::now();
        let samples_clone = samples.clone();
        let transcription_result = if samples.len() < SHORT_UTTERANCE_SAMPLES {
            debug!(
                "Using short-utterance fast path ({} samples)",
                samples.len()
            );
            transcribe_full_pass_with_timeout(&tm_for_worker, samples).await
        } else {
            transcribe_full_pass_with_timeout(&tm_for_worker, samples).await
        };
        match transcription_result {
            Ok(transcription) => {
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
            tokio::time::sleep(Duration::from_secs(12)).await;
            if task_completed.load(Ordering::Relaxed) {
                return;
            }

            warn!(
                "Transcription watchdog fired after 12s; forcing cancellation and coordinator reset"
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

        start_transcription_session(app, &binding_id, recording_started);

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
        let samples = rm.stop_recording(binding_id);
        handle_transcription_stop(app, binding_id, samples, post_process, tm, hm);

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

impl ShortcutAction for FullSystemTranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
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
            self.post_process || get_settings(app).post_process_enabled,
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
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod tests {
    use super::ACTION_MAP;

    #[test]
    fn full_system_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("transcribe_full_system_audio"));
    }
}
