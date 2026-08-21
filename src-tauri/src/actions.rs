use crate::access::{
    bootstrap_install_state, get_install_access_snapshot, install_access_allows_premium_features,
    install_access_allows_transcription, premium_feature_access_message, refresh_entitlement_state,
};
use crate::app_context::{collect_text_context, AppContextSnapshot};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::audio::mix_transcription_pcm_sources;
use crate::byok_secrets;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::full_system_audio::{
    FullSystemAudioSessionManager, FullSystemSessionSnapshot, FullSystemSessionStartResult,
    FullSystemSessionStopResult, FullSystemSessionTranscriptionSamples,
    FullSystemTranscriptionSource, FullSystemTranscriptionSourceSamples,
};
use crate::managers::history::HistoryManager;
use crate::managers::model::is_cloud_model_id;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{
    get_settings, normalize_custom_vocabulary_terms, write_settings, AppSettings,
    CleaningPromptPreset, PostProcessProvider, APPLE_INTELLIGENCE_PROVIDER_ID,
    STRICT_CLEANING_PROMPT,
};
use crate::shortcut;
use crate::summary_client;
use crate::transcription_coordinator::OperationId;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
    show_warming_overlay,
};
use crate::TranscriptionCoordinator;
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::time::{sleep, timeout};

const NO_INPUT_OVERLAY_MIN_DURATION: Duration = Duration::from_secs(4);
const PROCESSING_OVERLAY_DELAY: Duration = Duration::from_millis(500);
const RELEASE_SMOKE_TRANSCRIBING_HOLD_MS_DEFAULT: u64 = 1_500;
const FULL_SYSTEM_LIVE_CHUNK_SECONDS: usize = 10;
const FULL_SYSTEM_LIVE_CHUNK_SAMPLES: usize = 16_000 * FULL_SYSTEM_LIVE_CHUNK_SECONDS;
const FULL_SYSTEM_LIVE_CHUNK_POLL_INTERVAL: Duration = Duration::from_millis(250);
const FULL_SYSTEM_LIVE_WORKER_STOP_TIMEOUT: Duration = Duration::from_secs(15);
const FULL_SYSTEM_LIVE_FINAL_CHUNK_EXTRA_TIMEOUT: Duration = Duration::from_secs(10);
const FULL_SYSTEM_LIVE_SUMMARY_TIMEOUT: Duration = Duration::from_secs(75);
const FULL_SYSTEM_LIVE_SUMMARY_SECONDS: usize = 60;
const FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL: u64 =
    (FULL_SYSTEM_LIVE_SUMMARY_SECONDS / FULL_SYSTEM_LIVE_CHUNK_SECONDS) as u64;
const FULL_SYSTEM_SUMMARY_MODEL_FALLBACK: &str = "gpt-4o-mini";
const FULL_SYSTEM_SUMMARY_SYSTEM_PROMPT: &str = "You are the live meeting summarizer inside Uttr, a macOS transcription app. Update meeting notes from transcript text only. Return valid JSON only with current_gist and expanded key_points.";
const FINAL_TRANSCRIPTION_TIMEOUT_NOTICE: &str =
    "Audio was saved, but final transcription timed out. The transcript may be incomplete.";
const TRANSCRIPTION_FAILURE_NOTICE: &str =
    "Audio was saved, but transcription failed. The transcript may be incomplete.";

fn format_transcription_completion_log(elapsed: Duration, character_count: usize) -> String {
    format!(
        "Transcription completed in {:?} (chars={})",
        elapsed, character_count
    )
}

#[derive(Debug, Clone, Default)]
struct FullSystemLiveChunk {
    mixed_samples: Vec<f32>,
    source_samples: Vec<FullSystemTranscriptionSourceSamples>,
}

impl FullSystemLiveChunk {
    fn is_empty(&self) -> bool {
        self.mixed_samples.is_empty() && self.source_samples.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LabeledTranscriptSegment {
    source: FullSystemTranscriptionSource,
    text: String,
}

type FullSystemLiveTranscriptionTask =
    Arc<tokio::sync::Mutex<JoinHandle<Result<Vec<LabeledTranscriptSegment>, anyhow::Error>>>>;

#[derive(Debug, Clone)]
struct FullSystemLiveInFlightChunk {
    chunk: FullSystemLiveChunk,
    transcription_task: FullSystemLiveTranscriptionTask,
}

#[derive(Debug, Default)]
struct FullSystemLiveAudioState {
    pending_samples: Vec<f32>,
    pending_microphone_samples: Vec<f32>,
    pending_system_audio_samples: Vec<f32>,
    in_flight_chunk: Option<FullSystemLiveInFlightChunk>,
}

#[derive(Debug)]
struct FullSystemLiveFinalizationChunk {
    chunk: FullSystemLiveChunk,
    record_samples: bool,
    transcription_task: Option<FullSystemLiveTranscriptionTask>,
}

#[derive(Clone, Copy)]
enum DeferredOverlayState {
    Transcribing,
    Processing,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TranscriptionCompletionMode {
    Standard,
    EditMode,
    FullSystemOverlay,
}

#[derive(Clone)]
enum TranscriptionCompletionContext {
    Standalone,
    ReturnToMeeting {
        binding_id: String,
        operation_id: OperationId,
    },
}

#[derive(Clone, Copy)]
enum FullSystemProgressStage {
    Preparing,
    Transcribing,
    Processing,
    Complete,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionWindowStatePayload {
    stage: String,
    title: String,
    subtitle: String,
    progress_label: String,
    progress_value: f32,
    summary_text: Option<String>,
    raw_transcript_text: Option<String>,
    history_entry_id: Option<i64>,
}

#[derive(Debug)]
struct FullSystemLiveRuntime {
    stop_requested: AtomicBool,
    final_transcription_timed_out: AtomicBool,
    final_transcription_failed: AtomicBool,
    chunk_count: AtomicU64,
    transcript_text: Mutex<String>,
    summary_text: Mutex<Option<String>>,
    summary_provider: Mutex<Option<String>>,
    summary_error: Mutex<Option<String>>,
    summary_disabled: AtomicBool,
    recorded_samples: Mutex<Vec<f32>>,
    audio_state: Mutex<FullSystemLiveAudioState>,
    last_transcript_source: Mutex<Option<FullSystemTranscriptionSource>>,
}

impl FullSystemLiveRuntime {
    fn new() -> Self {
        Self {
            stop_requested: AtomicBool::new(false),
            final_transcription_timed_out: AtomicBool::new(false),
            final_transcription_failed: AtomicBool::new(false),
            chunk_count: AtomicU64::new(0),
            transcript_text: Mutex::new(String::new()),
            summary_text: Mutex::new(None),
            summary_provider: Mutex::new(None),
            summary_error: Mutex::new(None),
            summary_disabled: AtomicBool::new(false),
            recorded_samples: Mutex::new(Vec::new()),
            audio_state: Mutex::new(FullSystemLiveAudioState::default()),
            last_transcript_source: Mutex::new(None),
        }
    }
}

struct FullSystemLiveSession {
    binding_id: String,
    runtime: Arc<FullSystemLiveRuntime>,
    worker_handle: JoinHandle<()>,
}

struct FullSystemLiveFinal {
    transcript_text: String,
    summary_text: Option<String>,
    summary_provider: Option<String>,
    recorded_samples: Vec<f32>,
    chunk_count: u64,
    final_transcription_timed_out: bool,
    final_transcription_failed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FullSystemLiveStartDecision {
    recording_started: bool,
    initialize_live_runtime: bool,
    perform_start_side_effects: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FullSystemLiveSessionStatus {
    Missing,
    Running,
    Finalizing,
}

static FULL_SYSTEM_LIVE_SESSION: Lazy<Mutex<Option<FullSystemLiveSession>>> =
    Lazy::new(|| Mutex::new(None));
static FULL_SYSTEM_FINALIZATION_BARRIERS: Lazy<Mutex<HashMap<(String, OperationId), usize>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ACTIVE_APP_CONTEXT: Lazy<Mutex<HashMap<String, AppContextSnapshot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ACTIVE_APP_CONTEXT_REQUESTS: Lazy<Mutex<HashMap<String, u64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static APP_CONTEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static MEETING_QUICK_DICTATION_CANCEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE_QUICK_DICTATION_UI_OPERATION: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DictationOperationTerminalState {
    Cancelled,
    Completed,
}

static DICTATION_OPERATION_TERMINAL_STATES: Lazy<
    Mutex<HashMap<OperationId, DictationOperationTerminalState>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
static ASK_SELECTION_CHAT_SESSION: Lazy<Mutex<Option<AskSelectionChatSession>>> =
    Lazy::new(|| Mutex::new(None));
static ASK_SELECTION_CHAT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct AskSelectionChatSession {
    id: u64,
    owner_operation_id: Option<OperationId>,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
}

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
struct FinishGuard {
    app: AppHandle,
    binding_id: String,
    operation_id: OperationId,
    _full_system_finalization_barrier: Option<FullSystemFinalizationBarrier>,
}

struct FullSystemFinalizationBarrier {
    binding_id: String,
    operation_id: OperationId,
}

impl FullSystemFinalizationBarrier {
    fn new(binding_id: String, operation_id: OperationId) -> Self {
        *FULL_SYSTEM_FINALIZATION_BARRIERS
            .lock()
            .unwrap()
            .entry((binding_id.clone(), operation_id))
            .or_insert(0) += 1;
        Self {
            binding_id,
            operation_id,
        }
    }
}

impl Drop for FullSystemFinalizationBarrier {
    fn drop(&mut self) {
        let key = (self.binding_id.clone(), self.operation_id);
        let mut barriers = FULL_SYSTEM_FINALIZATION_BARRIERS.lock().unwrap();
        if let Some(count) = barriers.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                barriers.remove(&key);
            }
        }
    }
}

impl FinishGuard {
    fn new(app: AppHandle, binding_id: String, operation_id: OperationId) -> Self {
        Self {
            app,
            binding_id,
            operation_id,
            _full_system_finalization_barrier: None,
        }
    }

    fn new_full_system(app: AppHandle, binding_id: String, operation_id: OperationId) -> Self {
        Self {
            app,
            _full_system_finalization_barrier: Some(FullSystemFinalizationBarrier::new(
                binding_id.clone(),
                operation_id,
            )),
            binding_id,
            operation_id,
        }
    }
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        if let Some(c) = self.app.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished(&self.binding_id, self.operation_id);
        }
    }
}

struct CompletionOwner<T>(Option<T>);

impl<T> CompletionOwner<T> {
    fn new(owner: T) -> Self {
        Self(Some(owner))
    }

    fn transfer(&mut self) -> T {
        self.0
            .take()
            .expect("completion ownership can only be transferred once")
    }
}

/// Drop guard that always restores overlay/tray UI state when the
/// transcription task exits (success, error, or panic unwind).
struct UiResetGuard {
    app: AppHandle,
    enabled: bool,
    completion_context: TranscriptionCompletionContext,
}

impl UiResetGuard {
    fn new(app: AppHandle, completion_context: TranscriptionCompletionContext) -> Self {
        Self {
            app,
            enabled: true,
            completion_context,
        }
    }

    fn suppress(&mut self) {
        self.enabled = false;
    }
}

impl Drop for UiResetGuard {
    fn drop(&mut self) {
        if self.enabled {
            restore_ui_after_transcription(&self.app, &self.completion_context);
        }
    }
}

fn restore_ui_after_transcription(
    app: &AppHandle,
    completion_context: &TranscriptionCompletionContext,
) {
    match completion_context {
        TranscriptionCompletionContext::ReturnToMeeting { .. } => {
            let active_meeting_binding = app
                .try_state::<Arc<FullSystemAudioSessionManager>>()
                .and_then(|manager| manager.active_snapshot())
                .map(|snapshot| snapshot.binding_id);

            if !quick_dictation_ui_restore_is_current(completion_context) {
                debug!("Skipping stale quick-dictation UI restoration");
                return;
            }

            if should_restore_meeting_ui(completion_context, active_meeting_binding.as_deref()) {
                emit_active_session_window_state(app);
                utils::hide_recording_overlay(app);
                change_tray_icon(app, TrayIconState::Recording);
                shortcut::unregister_cancel_shortcut(app);
                return;
            }

            utils::hide_recording_overlay(app);
            change_tray_icon(app, TrayIconState::Idle);
        }
        TranscriptionCompletionContext::Standalone => {
            utils::hide_recording_overlay(app);
            change_tray_icon(app, TrayIconState::Idle);
        }
    }
}

fn should_restore_meeting_ui(
    completion_context: &TranscriptionCompletionContext,
    active_meeting_binding: Option<&str>,
) -> bool {
    match completion_context {
        TranscriptionCompletionContext::ReturnToMeeting { binding_id, .. } => {
            active_meeting_binding == Some(binding_id.as_str())
        }
        TranscriptionCompletionContext::Standalone => false,
    }
}

fn completion_context_for_active_meeting(
    active_meeting_binding: Option<String>,
    operation_id: OperationId,
) -> TranscriptionCompletionContext {
    active_meeting_binding
        .map(
            |binding_id| TranscriptionCompletionContext::ReturnToMeeting {
                binding_id,
                operation_id,
            },
        )
        .unwrap_or(TranscriptionCompletionContext::Standalone)
}

fn quick_dictation_ui_restore_is_current(
    completion_context: &TranscriptionCompletionContext,
) -> bool {
    let TranscriptionCompletionContext::ReturnToMeeting { operation_id, .. } = completion_context
    else {
        return true;
    };
    let active = ACTIVE_QUICK_DICTATION_UI_OPERATION.load(Ordering::Acquire);
    active == 0 || active == *operation_id
}

pub(crate) fn set_active_quick_dictation_ui_operation(operation_id: OperationId) {
    ACTIVE_QUICK_DICTATION_UI_OPERATION.store(operation_id, Ordering::Release);
}

pub(crate) fn clear_active_quick_dictation_ui_operation(operation_id: OperationId) {
    let _ = ACTIVE_QUICK_DICTATION_UI_OPERATION.compare_exchange(
        operation_id,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

fn restore_ui_or_show_no_input_feedback(
    app: &AppHandle,
    completion_context: &TranscriptionCompletionContext,
    post_process: bool,
) {
    match completion_context {
        TranscriptionCompletionContext::ReturnToMeeting { .. } => {
            restore_ui_after_transcription(app, completion_context);
        }
        TranscriptionCompletionContext::Standalone => {
            spawn_no_input_overlay_feedback(app, post_process);
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
    fn stop(
        &self,
        app: &AppHandle,
        binding_id: &str,
        shortcut_str: &str,
        operation_id: OperationId,
    );
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
    completion_mode: TranscriptionCompletionMode,
}

struct FullSystemTranscribeAction {
    post_process: bool,
}

struct TogglePostProcessingAction;

const GROQ_PROVIDER_ID: &str = "groq";
const GROQ_MODEL_PREFERENCES: &[&str] = &[
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "groq/compound-mini",
    "groq/compound",
    "moonshotai/kimi-k2-instruct-0905",
    "moonshotai/kimi-k2-instruct",
    "llama-3.1-8b-instant",
];
const FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT: Duration = Duration::from_secs(45);
const FULL_PASS_TRANSCRIPTION_TIMEOUT_PER_TEN_MINUTES: Duration = Duration::from_secs(60);
const FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE: Duration = Duration::from_secs(15);
const POST_PROCESS_TIMEOUT_DEFAULT: Duration = Duration::from_secs(20);
const SHORT_UTTERANCE_SAMPLES: usize = 16_000 * 10;

static AUTO_SELECTED_MODEL_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn toggle_post_process_enabled(settings: &mut AppSettings) -> bool {
    settings.post_process_enabled = !settings.post_process_enabled;
    settings.post_process_enabled
}

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
    context: Option<&AppContextSnapshot>,
) -> Option<String> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let api_key =
        match crate::byok_secrets::load_provider_api_key(app_handle, settings, &provider.id) {
            Ok(Some(key)) => key,
            Ok(None) => String::new(),
            Err(error) => {
                warn!(
                    "Failed to load API key for post-processing provider '{}': {}",
                    provider.id, error
                );
                String::new()
            }
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
    let processed_prompt = format!(
        "# Task\nClean the transcript. Return only the final cleaned transcript inside <uttr_output>...</uttr_output>. Do not include analysis, chat roles, markdown fences, or explanations.\n\n# Input\n{}\n\n# Output format\nWrap only the cleaned transcript like this:\n<uttr_output>\n...\n</uttr_output>",
        transcription
    );
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
                        let result = clean_post_process_response(&result);
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

    let resolved_system_prompt = resolved_post_process_system_prompt(settings, context);
    let resolved_system_prompt = resolved_system_prompt.as_deref();

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
            let content = clean_post_process_response(&content);
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

fn text_after_last_marker<'a>(content: &'a str, markers: &[&str]) -> Option<&'a str> {
    let lower = content.to_ascii_lowercase();
    markers
        .iter()
        .filter_map(|marker| {
            lower
                .rfind(marker)
                .map(|index| (index, index + marker.len()))
        })
        .max_by_key(|(index, _)| *index)
        .map(|(_, start)| &content[start..])
}

fn extract_tagged_output(content: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    let lower = content.to_ascii_lowercase();
    let open_index = lower.rfind(&open)?;
    let start = open_index + open.len();
    let remainder = &content[start..];
    let remainder_lower = &lower[start..];
    let end = remainder_lower.find(&close).unwrap_or(remainder.len());
    Some(remainder[..end].trim().to_string())
}

fn remove_tagged_block(mut content: String, tag: &str) -> String {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);

    loop {
        let lower = content.to_ascii_lowercase();
        let Some(open_index) = lower.find(&open) else {
            break;
        };
        let search_start = open_index + open.len();
        if let Some(relative_close_index) = lower[search_start..].find(&close) {
            let close_end = search_start + relative_close_index + close.len();
            content.replace_range(open_index..close_end, "");
        } else {
            content.replace_range(open_index.., "");
            break;
        }
    }

    content
}

fn trim_chat_stop_tokens(content: &str) -> String {
    let stop_tokens = ["<|end|>", "<|endoftext|>", "<|eot_id|>"];
    let mut end = content.len();
    for token in stop_tokens {
        if let Some(index) = content.find(token) {
            end = end.min(index);
        }
    }
    content[..end].trim().to_string()
}

fn strip_wrapping_code_fence(content: &str) -> String {
    let trimmed = content.trim();
    if !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return trimmed.to_string();
    }

    let mut lines = trimmed.lines();
    let _opening = lines.next();
    let mut body: Vec<&str> = lines.collect();
    if body.last().map(|line| line.trim()) == Some("```") {
        body.pop();
    }
    body.join("\n").trim().to_string()
}

fn clean_post_process_response(content: &str) -> String {
    if let Some(output) = extract_tagged_output(content, "uttr_output") {
        return strip_wrapping_code_fence(&trim_chat_stop_tokens(&output));
    }

    let mut cleaned = content.to_string();
    if let Some(final_segment) = text_after_last_marker(
        &cleaned,
        &[
            "<|channel|>final<|message|>",
            "<|channel|>final\n<|message|>",
            "<|final|>",
            "\nfinal answer:",
            "\nfinal:",
            "\n# output\n",
            "\noutput:",
        ],
    ) {
        cleaned = final_segment.to_string();
    } else {
        let lower = cleaned.to_ascii_lowercase();
        for prefix in ["final answer:", "final:", "# output\n", "output:"] {
            if lower.starts_with(prefix) {
                cleaned = cleaned[prefix.len()..].to_string();
                break;
            }
        }
    }

    cleaned = remove_tagged_block(cleaned, "think");
    cleaned = remove_tagged_block(cleaned, "analysis");
    cleaned = trim_chat_stop_tokens(&cleaned);
    cleaned = cleaned
        .replace("<uttr_output>", "")
        .replace("</uttr_output>", "");
    strip_wrapping_code_fence(&cleaned)
}

fn take_active_context(binding_id: &str, wait_for_capture: bool) -> AppContextSnapshot {
    const CONTEXT_CAPTURE_WAIT_ATTEMPTS: usize = 15;
    const CONTEXT_CAPTURE_WAIT_STEP: Duration = Duration::from_millis(100);

    if wait_for_capture {
        for _ in 0..CONTEXT_CAPTURE_WAIT_ATTEMPTS {
            if ACTIVE_APP_CONTEXT.lock().unwrap().contains_key(binding_id) {
                break;
            }
            if !ACTIVE_APP_CONTEXT_REQUESTS
                .lock()
                .unwrap()
                .contains_key(binding_id)
            {
                break;
            }
            std::thread::sleep(CONTEXT_CAPTURE_WAIT_STEP);
        }
    }

    ACTIVE_APP_CONTEXT_REQUESTS
        .lock()
        .unwrap()
        .remove(binding_id);
    ACTIVE_APP_CONTEXT
        .lock()
        .unwrap()
        .remove(binding_id)
        .unwrap_or_default()
}

fn store_active_context_async(binding_id: &str) {
    let binding_id = binding_id.to_string();
    let request_id = APP_CONTEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);

    ACTIVE_APP_CONTEXT.lock().unwrap().remove(&binding_id);
    ACTIVE_APP_CONTEXT_REQUESTS
        .lock()
        .unwrap()
        .insert(binding_id.clone(), request_id);

    std::thread::spawn(move || {
        let started = Instant::now();
        let snapshot = collect_text_context();
        let should_store = ACTIVE_APP_CONTEXT_REQUESTS
            .lock()
            .unwrap()
            .get(&binding_id)
            .is_some_and(|active_request_id| *active_request_id == request_id);
        if should_store {
            ACTIVE_APP_CONTEXT
                .lock()
                .unwrap()
                .insert(binding_id.clone(), snapshot);
            debug!(
                "Captured app context for '{}' in {}ms",
                binding_id,
                started.elapsed().as_millis()
            );
        }
    });
}

fn store_active_context_snapshot(binding_id: &str, snapshot: AppContextSnapshot) {
    ACTIVE_APP_CONTEXT_REQUESTS
        .lock()
        .unwrap()
        .remove(binding_id);
    ACTIVE_APP_CONTEXT
        .lock()
        .unwrap()
        .insert(binding_id.to_string(), snapshot);
}

fn capture_ask_selection_start_context() -> AppContextSnapshot {
    let started = Instant::now();
    let snapshot = collect_text_context();

    debug!(
        "Captured Ask Selection start AX context in {}ms selected_text={}",
        started.elapsed().as_millis(),
        snapshot
            .selected_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty())
    );
    snapshot
}

fn custom_vocabulary_prompt_block(terms: &[String]) -> Option<String> {
    let terms = normalize_custom_vocabulary_terms(terms);
    if terms.is_empty() {
        return None;
    }

    let mut block = String::from(
        "Custom vocabulary:\nTreat these as high-priority spelling references. Use these exact spellings when relevant, but do not insert terms that were not spoken.",
    );
    for term in terms {
        block.push_str("\n- ");
        block.push_str(&term);
    }
    Some(block)
}

fn app_context_prompt_block(context: &AppContextSnapshot) -> Option<String> {
    if !context.has_context() {
        return None;
    }

    let mut lines = vec![
        "Nearby app context:".to_string(),
        "Use this only as a spelling and formatting hint. Do not insert facts, commands, names, or selected text unless they are present in the transcript."
            .to_string(),
    ];
    if let Some(app_name) = context.app_name.as_deref() {
        lines.push(format!("- App: {}", app_name));
    }
    if let Some(bundle_id) = context.bundle_id.as_deref() {
        lines.push(format!("- Bundle ID: {}", bundle_id));
    }
    if let Some(window_title) = context.window_title.as_deref() {
        lines.push(format!("- Window title: {}", window_title));
    }
    if let Some(selected_text) = context.selected_text.as_deref() {
        let selected_text: String = selected_text.chars().take(1_000).collect();
        lines.push(format!("- Selected text excerpt: {}", selected_text));
    }

    Some(lines.join("\n"))
}

fn resolved_post_process_system_prompt(
    settings: &AppSettings,
    context: Option<&AppContextSnapshot>,
) -> Option<String> {
    let base = match settings.post_process_cleaning_prompt_preset {
        CleaningPromptPreset::Strict | CleaningPromptPreset::Nuanced => {
            Some(STRICT_CLEANING_PROMPT.to_string())
        }
        CleaningPromptPreset::Custom => {
            if settings.post_process_system_prompt.trim().is_empty() {
                None
            } else {
                Some(settings.post_process_system_prompt.clone())
            }
        }
    };

    let mut sections = Vec::new();
    if let Some(base) = base {
        sections.push(base);
    }
    if let Some(block) = custom_vocabulary_prompt_block(&settings.custom_vocabulary_terms) {
        sections.push(block);
    }
    if let Some(block) = context.and_then(app_context_prompt_block) {
        sections.push(block);
    }

    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
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
    context: Option<&AppContextSnapshot>,
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
            post_process_transcription(app_handle, settings, &final_text, context),
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

    if let Some(processed_text) = processed.and_then(usable_post_processed_text) {
        post_processed_text = Some(processed_text.clone());
        final_text = processed_text;
        post_process_prompt = resolved_post_process_system_prompt(settings, context);
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    FinalizedTranscriptionOutput {
        final_text,
        post_processed_text,
        post_process_prompt,
    }
}

fn usable_post_processed_text(processed_text: String) -> Option<String> {
    if processed_text.trim().is_empty() {
        warn!("Post-processing returned empty text; keeping base transcription");
        None
    } else {
        Some(processed_text)
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

fn full_system_live_chunk_transcription_timeout(chunk: &FullSystemLiveChunk) -> Duration {
    let source_budget = chunk
        .source_samples
        .iter()
        .filter(|source| !source.samples.is_empty())
        .fold(Duration::ZERO, |budget, source| {
            budget.saturating_add(transcription_timeout_for_samples(source.samples.len()))
        });
    let transcription_budget = if source_budget.is_zero() {
        transcription_timeout_for_samples(chunk.mixed_samples.len())
    } else {
        source_budget
    };

    transcription_budget + FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE
}

fn full_system_live_final_chunk_timeout(chunk: &FullSystemLiveChunk) -> Duration {
    full_system_live_chunk_transcription_timeout(chunk) + FULL_SYSTEM_LIVE_FINAL_CHUNK_EXTRA_TIMEOUT
}

fn transcription_source_for_binding(binding_id: &str) -> Option<&'static str> {
    match binding_id {
        "transcribe_full_system_audio" => Some("full_system_audio"),
        _ => None,
    }
}

async fn show_deferred_overlay_state(
    app: &AppHandle,
    state: DeferredOverlayState,
    overlay_epoch: u64,
) {
    tokio::time::sleep(PROCESSING_OVERLAY_DELAY).await;
    if utils::current_overlay_session_epoch() != overlay_epoch {
        return;
    }

    match state {
        DeferredOverlayState::Transcribing => show_transcribing_overlay(app),
        DeferredOverlayState::Processing => show_processing_overlay(app),
    }
}

fn spawn_deferred_overlay_state(app: &AppHandle, state: DeferredOverlayState) {
    let ah = app.clone();
    let overlay_epoch = utils::current_overlay_session_epoch();
    tauri::async_runtime::spawn(async move {
        show_deferred_overlay_state(&ah, state, overlay_epoch).await;
    });
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

fn release_smoke_enabled() -> bool {
    std::env::var("UTTR_RELEASE_SMOKE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

fn release_smoke_transcribing_hold_duration() -> Option<Duration> {
    if !release_smoke_enabled() {
        return None;
    }

    let hold_ms = std::env::var("UTTR_RELEASE_SMOKE_TRANSCRIBING_HOLD_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(RELEASE_SMOKE_TRANSCRIBING_HOLD_MS_DEFAULT);

    (hold_ms > 0).then(|| Duration::from_millis(hold_ms))
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
    const MAX_SILENT_RMS: f32 = 0.005;
    const MAX_SILENT_PEAK: f32 = 0.05;

    let Some((rms, peak)) = silent_audio_levels(samples) else {
        return true;
    };

    rms <= MAX_SILENT_RMS && peak <= MAX_SILENT_PEAK
}

fn is_effectively_silent_full_system_source_audio(samples: &[f32]) -> bool {
    const MAX_SILENT_RMS: f32 = 0.0035;
    const MAX_SILENT_PEAK: f32 = 0.02;

    let Some((rms, peak)) = silent_audio_levels(samples) else {
        return true;
    };

    rms <= MAX_SILENT_RMS && peak <= MAX_SILENT_PEAK
}

fn should_refresh_microphone_stream_after_suspected_no_input(
    settings: &AppSettings,
    completion_mode: TranscriptionCompletionMode,
) -> bool {
    completion_mode == TranscriptionCompletionMode::Standard
        && settings.always_on_microphone
        && settings.selected_microphone.is_some()
}

fn refresh_microphone_stream_after_suspected_no_input(
    app: &AppHandle,
    binding_id: &str,
    completion_mode: TranscriptionCompletionMode,
) {
    let settings = get_settings(app);
    if !should_refresh_microphone_stream_after_suspected_no_input(&settings, completion_mode) {
        return;
    }

    let Some(recorder) = app.try_state::<Arc<AudioRecordingManager>>() else {
        return;
    };

    log::info!(
        "Refreshing microphone stream after suspected no-input capture for '{}'",
        binding_id
    );
    if let Err(err) = recorder.update_selected_device() {
        warn!(
            "Failed to refresh microphone stream after suspected no-input capture: {}",
            err
        );
    }
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
        if should_register_cancel_shortcut(binding_id, started) {
            shortcut::register_cancel_shortcut(app);
        } else {
            shortcut::unregister_cancel_shortcut(app);
        }
    } else {
        utils::hide_recording_overlay(app);
        change_tray_icon(app, TrayIconState::Idle);
    }
    debug!(
        "Transcription session start completed for '{}' (started={})",
        binding_id, started
    );
}

fn should_register_cancel_shortcut(binding_id: &str, started: bool) -> bool {
    started && binding_id != "transcribe_full_system_audio"
}

fn active_meeting_binding_for_quick_dictation(app: &AppHandle, binding_id: &str) -> Option<String> {
    if binding_id != "transcribe" {
        return None;
    }

    app.try_state::<Arc<FullSystemAudioSessionManager>>()
        .and_then(|manager| manager.active_snapshot())
        .map(|snapshot| snapshot.binding_id)
}

pub fn cancel_meeting_quick_dictation_recording(
    app: &AppHandle,
    quick_binding_id: &str,
    meeting_binding_id: &str,
    operation_id: OperationId,
) {
    if !cancel_dictation_operation(operation_id) {
        return;
    }
    if let Some(manager) = app.try_state::<Arc<AudioRecordingManager>>() {
        let _ = manager.finish_borrowed_recording_and_restore(quick_binding_id, meeting_binding_id);
    }
    if let Some(manager) = app.try_state::<Arc<TranscriptionManager>>() {
        manager.cancel_incremental_session();
    }
    clear_active_quick_dictation_ui_operation(operation_id);
    restore_meeting_after_quick_dictation_cancel(app);
    release_dictation_operation(operation_id);
}

pub fn cancel_dictation_operation(operation_id: OperationId) -> bool {
    let mut states = DICTATION_OPERATION_TERMINAL_STATES.lock().unwrap();
    if states.contains_key(&operation_id) {
        return false;
    }
    insert_dictation_operation_terminal_state(
        &mut states,
        operation_id,
        DictationOperationTerminalState::Cancelled,
    );
    true
}

pub(crate) fn release_dictation_operation(operation_id: OperationId) {
    DICTATION_OPERATION_TERMINAL_STATES
        .lock()
        .unwrap()
        .remove(&operation_id);
}

fn insert_dictation_operation_terminal_state(
    states: &mut HashMap<OperationId, DictationOperationTerminalState>,
    operation_id: OperationId,
    state: DictationOperationTerminalState,
) {
    states.insert(operation_id, state);
}

pub fn cancel_standalone_dictation_recording_operation(
    app: &AppHandle,
    binding_id: &str,
    operation_id: OperationId,
) {
    if !cancel_dictation_operation(operation_id) {
        return;
    }
    cancel_ask_selection_operation(app, operation_id);
    if let Some(manager) = app.try_state::<Arc<AudioRecordingManager>>() {
        manager.cancel_recording();
    }
    if let Some(manager) = app.try_state::<Arc<TranscriptionManager>>() {
        manager.cancel_incremental_session();
    }
    clear_active_quick_dictation_ui_operation(operation_id);
    shortcut::unregister_cancel_shortcut(app);
    utils::hide_recording_overlay(app);
    change_tray_icon(app, TrayIconState::Idle);
    release_dictation_operation(operation_id);
    debug!("Cancelled dictation recording '{binding_id}' during meeting finalization");
}

pub fn cancel_standalone_dictation_processing_operation(
    app: &AppHandle,
    operation_id: OperationId,
) {
    if !cancel_dictation_operation(operation_id) {
        return;
    }
    cancel_ask_selection_operation(app, operation_id);
    clear_active_quick_dictation_ui_operation(operation_id);
    shortcut::unregister_cancel_shortcut(app);
    utils::hide_recording_overlay(app);
    change_tray_icon(app, TrayIconState::Idle);
    debug!("Cancelled dictation processing during meeting finalization");
}

fn dictation_operation_was_cancelled(operation_id: OperationId) -> bool {
    matches!(
        DICTATION_OPERATION_TERMINAL_STATES
            .lock()
            .unwrap()
            .get(&operation_id),
        Some(DictationOperationTerminalState::Cancelled)
    )
}

fn complete_dictation_operation_if_active<F>(operation_id: OperationId, complete: F) -> bool
where
    F: FnOnce(),
{
    let mut states = DICTATION_OPERATION_TERMINAL_STATES.lock().unwrap();
    if states.contains_key(&operation_id) {
        return false;
    }
    insert_dictation_operation_terminal_state(
        &mut states,
        operation_id,
        DictationOperationTerminalState::Completed,
    );
    complete();
    true
}

fn complete_transcription_ui_if_active<F>(
    completion_mode: TranscriptionCompletionMode,
    operation_id: OperationId,
    complete: F,
) -> bool
where
    F: FnOnce(),
{
    if completion_mode == TranscriptionCompletionMode::FullSystemOverlay {
        complete();
        true
    } else {
        complete_dictation_operation_if_active(operation_id, complete)
    }
}

fn publish_transcription_error_if_operation_active<F>(operation_id: OperationId, publish: F) -> bool
where
    F: FnOnce(),
{
    complete_dictation_operation_if_active(operation_id, publish)
}

async fn await_dictation_post_processing_if_active<F, T>(
    operation_id: OperationId,
    post_processing: F,
) -> Option<T>
where
    F: Future<Output = T>,
{
    if dictation_operation_was_cancelled(operation_id) {
        return None;
    }

    let output = post_processing.await;
    (!dictation_operation_was_cancelled(operation_id)).then_some(output)
}

fn dictation_output_was_cancelled(
    operation_id: OperationId,
    completion_context: &TranscriptionCompletionContext,
    quick_cancel_generation_at_start: u64,
    transcription_manager: &TranscriptionManager,
    cancel_generation_at_start: u64,
) -> bool {
    dictation_operation_was_cancelled(operation_id)
        || meeting_quick_dictation_was_cancelled(
            completion_context,
            quick_cancel_generation_at_start,
        )
        || transcription_manager.is_cancel_requested()
        || transcription_manager.cancel_generation() != cancel_generation_at_start
}

async fn persist_with_cancellation_rollback<IsCancelled, Save, SaveFuture, Rollback, Error>(
    is_cancelled: IsCancelled,
    save: Save,
    rollback: Rollback,
) -> Result<Option<i64>, Error>
where
    IsCancelled: Fn() -> bool,
    Save: FnOnce() -> SaveFuture,
    SaveFuture: Future<Output = Result<i64, Error>>,
    Rollback: FnOnce(i64) -> Result<(), Error>,
{
    if is_cancelled() {
        return Ok(None);
    }

    let entry_id = save().await?;
    if is_cancelled() {
        rollback(entry_id)?;
        return Ok(None);
    }

    Ok(Some(entry_id))
}

fn rollback_cancelled_dictation_history(hm: &HistoryManager, entry_id: Option<i64>) {
    let Some(entry_id) = entry_id else {
        return;
    };
    if let Err(error) = hm.rollback_dictation_entry(entry_id) {
        error!(
            "Failed to roll back cancelled dictation history entry {}: {}",
            entry_id, error
        );
    }
}

fn complete_persisted_dictation_if_active<F>(
    history_manager: &HistoryManager,
    persisted_entry_id: Option<i64>,
    operation_id: OperationId,
    complete: F,
) -> bool
where
    F: FnOnce(),
{
    let committed = complete_dictation_operation_if_active(operation_id, complete);
    if !committed {
        rollback_cancelled_dictation_history(history_manager, persisted_entry_id);
    }
    committed
}

pub fn cancel_meeting_quick_dictation_operation(app: &AppHandle, operation_id: OperationId) {
    if !cancel_dictation_operation(operation_id) {
        return;
    }
    MEETING_QUICK_DICTATION_CANCEL_GENERATION.fetch_add(1, Ordering::Relaxed);
    clear_active_quick_dictation_ui_operation(operation_id);
    restore_meeting_after_quick_dictation_cancel(app);
}

fn restore_meeting_after_quick_dictation_cancel(app: &AppHandle) {
    shortcut::unregister_cancel_shortcut(app);
    emit_active_session_window_state(app);
    utils::hide_recording_overlay(app);
    change_tray_icon(app, TrayIconState::Recording);
}

fn meeting_quick_dictation_was_cancelled(
    completion_context: &TranscriptionCompletionContext,
    generation_at_start: u64,
) -> bool {
    should_suppress_quick_dictation_output(
        matches!(
            completion_context,
            TranscriptionCompletionContext::ReturnToMeeting { .. }
        ),
        generation_at_start,
        MEETING_QUICK_DICTATION_CANCEL_GENERATION.load(Ordering::Relaxed),
    )
}

fn should_suppress_quick_dictation_output(
    returns_to_meeting: bool,
    generation_at_start: u64,
    current_generation: u64,
) -> bool {
    returns_to_meeting && current_generation != generation_at_start
}

fn meeting_microphone_binding_for_quick_dictation(
    app: &AppHandle,
    binding_id: &str,
) -> Option<String> {
    if binding_id != "transcribe" {
        return None;
    }

    app.try_state::<Arc<FullSystemAudioSessionManager>>()
        .and_then(|manager| manager.active_snapshot())
        .filter(|snapshot| snapshot.microphone.is_active())
        .map(|snapshot| snapshot.binding_id)
}

fn borrow_meeting_microphone_for_quick_dictation(
    app: &AppHandle,
    rm: &AudioRecordingManager,
    meeting_binding_id: &str,
    quick_binding_id: &str,
) -> bool {
    if let Some(full_system_audio) = app.try_state::<Arc<FullSystemAudioSessionManager>>() {
        if let Some(delta) = full_system_audio.drain_session_delta_sources(meeting_binding_id) {
            append_full_system_live_session_delta(meeting_binding_id, delta);
        }
    }

    rm.borrow_recording_binding_with_boundary(meeting_binding_id, quick_binding_id)
}

pub fn promote_active_transcription_to_edit_mode(
    app: &AppHandle,
    from_binding_id: &str,
    to_binding_id: &str,
) -> bool {
    if from_binding_id == to_binding_id || to_binding_id != "edit_mode" {
        warn!(
            "[ask-hotkey] promote_rejected invalid_target from={} to={}",
            from_binding_id, to_binding_id
        );
        return false;
    }

    let settings = get_settings(app);
    if !settings.edit_mode_enabled {
        warn!(
            "[ask-hotkey] promote_rejected edit_mode_disabled from={} to={}",
            from_binding_id, to_binding_id
        );
        return false;
    }

    let rm = app.state::<Arc<AudioRecordingManager>>();
    if !rm.transfer_recording_binding(from_binding_id, to_binding_id) {
        warn!(
            "[ask-hotkey] promote_rejected audio_owner_mismatch from={} to={}",
            from_binding_id, to_binding_id
        );
        return false;
    }

    clear_ask_selection_session();
    utils::hide_ask_selection_panel(app);
    let context_start = Instant::now();
    let snapshot = capture_ask_selection_start_context();
    store_active_context_snapshot(to_binding_id, snapshot);

    if let Some(tm) = app.try_state::<Arc<TranscriptionManager>>() {
        tm.cancel_incremental_session();
    }

    log::info!(
        "[latency] promoted active transcription to edit_mode from_binding={} elapsed_ms={}",
        from_binding_id,
        context_start.elapsed().as_millis()
    );
    warn!(
        "[ask-hotkey] promoted_active_recording from={} to={} context_elapsed_ms={}",
        from_binding_id,
        to_binding_id,
        context_start.elapsed().as_millis()
    );
    true
}

fn focus_workspace_window(app: &AppHandle) {
    if let Some(main_window) = app.get_webview_window("main") {
        if let Err(e) = main_window.show() {
            error!("Failed to show main window: {}", e);
        }
        if let Err(e) = main_window.set_focus() {
            error!("Failed to focus main window: {}", e);
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                error!("Failed to set activation policy to Regular: {}", e);
            }
        }
    }
}

fn emit_session_window_state(app: &AppHandle, payload: SessionWindowStatePayload) {
    if let Err(e) = app.emit("session-window-state", payload) {
        warn!("Failed to emit session-window-state: {}", e);
    }
}

fn session_window_state_payload(
    stage: FullSystemProgressStage,
    summary_text: Option<String>,
    raw_transcript_text: Option<String>,
    history_entry_id: Option<i64>,
) -> SessionWindowStatePayload {
    match stage {
        FullSystemProgressStage::Preparing => SessionWindowStatePayload {
            stage: "preparing".to_string(),
            title: "Preparing session".to_string(),
            subtitle: "System audio and microphone capture are being prepared.".to_string(),
            progress_label: "Preparing audio".to_string(),
            progress_value: 0.18,
            summary_text: None,
            raw_transcript_text: None,
            history_entry_id: None,
        },
        FullSystemProgressStage::Transcribing => SessionWindowStatePayload {
            stage: "transcribing".to_string(),
            title: "Transcribing session".to_string(),
            subtitle: "Working through the captured system and microphone audio.".to_string(),
            progress_label: "Transcribing".to_string(),
            progress_value: 0.66,
            summary_text: None,
            raw_transcript_text: None,
            history_entry_id: None,
        },
        FullSystemProgressStage::Processing => SessionWindowStatePayload {
            stage: "processing".to_string(),
            title: "Preparing summary".to_string(),
            subtitle: "Cleaning up the transcript before saving the session.".to_string(),
            progress_label: "Post-processing".to_string(),
            progress_value: 0.88,
            summary_text: None,
            raw_transcript_text: None,
            history_entry_id: None,
        },
        FullSystemProgressStage::Complete => SessionWindowStatePayload {
            stage: "complete".to_string(),
            title: "Session saved".to_string(),
            subtitle: "The transcript is ready under Meetings.".to_string(),
            progress_label: "Complete".to_string(),
            progress_value: 1.0,
            summary_text,
            raw_transcript_text,
            history_entry_id,
        },
    }
}

fn emit_active_session_window_state(app: &AppHandle) {
    emit_session_window_state(
        app,
        SessionWindowStatePayload {
            stage: "active".to_string(),
            title: "Live session".to_string(),
            subtitle: "Capturing system audio and microphone audio.".to_string(),
            progress_label: "Recording".to_string(),
            progress_value: 0.0,
            summary_text: None,
            raw_transcript_text: None,
            history_entry_id: None,
        },
    );
}

fn emit_idle_session_window_state(app: &AppHandle) {
    emit_session_window_state(
        app,
        SessionWindowStatePayload {
            stage: "idle".to_string(),
            title: "Open Uttr".to_string(),
            subtitle: String::new(),
            progress_label: String::new(),
            progress_value: 0.0,
            summary_text: None,
            raw_transcript_text: None,
            history_entry_id: None,
        },
    );
}

fn full_system_source_label(source: FullSystemTranscriptionSource) -> &'static str {
    match source {
        FullSystemTranscriptionSource::Microphone => "Me",
        FullSystemTranscriptionSource::SystemAudio => "Them",
    }
}

fn full_system_source_transcription_id(source: FullSystemTranscriptionSource) -> &'static str {
    match source {
        FullSystemTranscriptionSource::Microphone => "full_system_audio_microphone",
        FullSystemTranscriptionSource::SystemAudio => "full_system_audio_system",
    }
}

#[cfg(test)]
fn format_labeled_transcript_segments(segments: &[LabeledTranscriptSegment]) -> String {
    let mut output = String::new();
    let mut last_source = None;

    for segment in segments {
        append_labeled_live_text(&mut output, &mut last_source, segment.source, &segment.text);
    }

    output
}

fn append_labeled_live_text(
    existing: &mut String,
    last_source: &mut Option<FullSystemTranscriptionSource>,
    source: FullSystemTranscriptionSource,
    incoming: &str,
) {
    let incoming = incoming.trim();
    if incoming.is_empty() {
        return;
    }

    if existing.trim().is_empty() {
        existing.push_str(full_system_source_label(source));
        existing.push_str(": ");
        existing.push_str(incoming);
        *last_source = Some(source);
        return;
    }

    if *last_source == Some(source) {
        existing.push(' ');
        existing.push_str(incoming);
    } else {
        existing.push_str("\n\n");
        existing.push_str(full_system_source_label(source));
        existing.push_str(": ");
        existing.push_str(incoming);
        *last_source = Some(source);
    }
}

fn append_live_transcription_segments(
    runtime: &FullSystemLiveRuntime,
    transcription_segments: &[LabeledTranscriptSegment],
) -> String {
    let mut transcript = runtime.transcript_text.lock().unwrap();
    let mut last_source = runtime.last_transcript_source.lock().unwrap();
    for segment in transcription_segments {
        append_labeled_live_text(
            &mut transcript,
            &mut last_source,
            segment.source,
            &segment.text,
        );
    }
    transcript.clone()
}

fn commit_full_system_live_transcription_segments(
    runtime: &FullSystemLiveRuntime,
    transcription_segments: &[LabeledTranscriptSegment],
    tracked_in_flight: bool,
) -> Option<(String, u64)> {
    if transcription_segments.is_empty() {
        if tracked_in_flight {
            clear_full_system_live_in_flight_chunk(runtime);
        }
        return None;
    }

    let transcript_so_far = append_live_transcription_segments(runtime, transcription_segments);
    if tracked_in_flight {
        // Clearing the recovery marker is the commit point. Keep it synchronous
        // and before any summary await so Stop can distinguish committed audio
        // from a chunk whose retained transcription task still needs settling.
        clear_full_system_live_in_flight_chunk(runtime);
    }
    let completed_chunk = runtime.chunk_count.fetch_add(1, Ordering::Relaxed) + 1;
    Some((transcript_so_far, completed_chunk))
}

fn record_full_system_live_chunk_samples(
    runtime: &FullSystemLiveRuntime,
    chunk: &FullSystemLiveChunk,
) {
    runtime
        .recorded_samples
        .lock()
        .unwrap()
        .extend_from_slice(&chunk.mixed_samples);
}

fn record_full_system_live_finalization_audio(
    runtime: &FullSystemLiveRuntime,
    finalization_chunks: &[FullSystemLiveFinalizationChunk],
) {
    for finalization in finalization_chunks {
        if finalization.record_samples {
            record_full_system_live_chunk_samples(runtime, &finalization.chunk);
        }
    }
}

fn snapshot_full_system_live_runtime(
    runtime: &FullSystemLiveRuntime,
) -> Option<FullSystemLiveFinal> {
    let transcript_text = runtime.transcript_text.lock().unwrap().clone();
    let summary_text = runtime.summary_text.lock().unwrap().clone();
    let summary_provider = runtime.summary_provider.lock().unwrap().clone();
    let recorded_samples = runtime.recorded_samples.lock().unwrap().clone();
    let chunk_count = runtime.chunk_count.load(Ordering::Relaxed);

    if transcript_text.trim().is_empty() && recorded_samples.is_empty() {
        return None;
    }

    Some(FullSystemLiveFinal {
        transcript_text,
        summary_text,
        summary_provider,
        recorded_samples,
        chunk_count,
        final_transcription_timed_out: runtime
            .final_transcription_timed_out
            .load(Ordering::Relaxed),
        final_transcription_failed: runtime.final_transcription_failed.load(Ordering::Relaxed),
    })
}

fn should_persist_full_system_live_final(live_final: &FullSystemLiveFinal) -> bool {
    !live_final.transcript_text.trim().is_empty()
        || ((live_final.final_transcription_timed_out || live_final.final_transcription_failed)
            && !live_final.recorded_samples.is_empty())
}

async fn persist_full_system_live_final(
    history_manager: &HistoryManager,
    live_final: &FullSystemLiveFinal,
) -> anyhow::Result<i64> {
    history_manager
        .save_transcription(
            live_final.recorded_samples.clone(),
            live_final.transcript_text.clone(),
            live_final.summary_text.clone(),
            Some(format!(
                "Live session summary via {} after {} chunk(s)",
                live_final
                    .summary_provider
                    .clone()
                    .unwrap_or_else(|| "live summary".to_string()),
                live_final.chunk_count
            )),
            "full_system_audio",
        )
        .await
}

fn drain_front_up_to(samples: &mut Vec<f32>, max_len: usize) -> Vec<f32> {
    let len = samples.len().min(max_len);
    if len == 0 {
        Vec::new()
    } else {
        samples.drain(..len).collect()
    }
}

fn source_samples_from_buffers(
    microphone_samples: Vec<f32>,
    system_audio_samples: Vec<f32>,
) -> Vec<FullSystemTranscriptionSourceSamples> {
    let mut source_samples = Vec::new();
    if !microphone_samples.is_empty() {
        source_samples.push(FullSystemTranscriptionSourceSamples {
            source: FullSystemTranscriptionSource::Microphone,
            samples: microphone_samples,
        });
    }
    if !system_audio_samples.is_empty() {
        source_samples.push(FullSystemTranscriptionSourceSamples {
            source: FullSystemTranscriptionSource::SystemAudio,
            samples: system_audio_samples,
        });
    }
    source_samples
}

fn append_full_system_live_audio_delta(
    state: &mut FullSystemLiveAudioState,
    delta: FullSystemSessionTranscriptionSamples,
) {
    if let Some(mixed) = delta.mixed.filter(|samples| !samples.is_empty()) {
        state.pending_samples.extend_from_slice(&mixed);
    }
    for source_samples in delta.sources {
        match source_samples.source {
            FullSystemTranscriptionSource::Microphone => state
                .pending_microphone_samples
                .extend_from_slice(&source_samples.samples),
            FullSystemTranscriptionSource::SystemAudio => state
                .pending_system_audio_samples
                .extend_from_slice(&source_samples.samples),
        }
    }
}

fn take_next_full_system_live_chunk<F>(
    runtime: &FullSystemLiveRuntime,
    start_transcription: F,
) -> Option<FullSystemLiveInFlightChunk>
where
    F: FnOnce(FullSystemLiveChunk, u64) -> FullSystemLiveTranscriptionTask,
{
    let mut state = runtime.audio_state.lock().unwrap();
    if state.pending_samples.len() < FULL_SYSTEM_LIVE_CHUNK_SAMPLES {
        return None;
    }

    let chunk = FullSystemLiveChunk {
        mixed_samples: drain_front_up_to(
            &mut state.pending_samples,
            FULL_SYSTEM_LIVE_CHUNK_SAMPLES,
        ),
        source_samples: source_samples_from_buffers(
            drain_front_up_to(
                &mut state.pending_microphone_samples,
                FULL_SYSTEM_LIVE_CHUNK_SAMPLES,
            ),
            drain_front_up_to(
                &mut state.pending_system_audio_samples,
                FULL_SYSTEM_LIVE_CHUNK_SAMPLES,
            ),
        ),
    };
    let chunk_index = runtime.chunk_count.load(Ordering::Relaxed) + 1;
    let in_flight = FullSystemLiveInFlightChunk {
        transcription_task: start_transcription(chunk.clone(), chunk_index),
        chunk,
    };
    state.in_flight_chunk = Some(in_flight.clone());
    Some(in_flight)
}

fn clear_full_system_live_in_flight_chunk(runtime: &FullSystemLiveRuntime) {
    runtime.audio_state.lock().unwrap().in_flight_chunk = None;
}

fn take_full_system_live_finalization_chunks(
    runtime: &FullSystemLiveRuntime,
    tail_samples: Option<FullSystemSessionTranscriptionSamples>,
) -> Vec<FullSystemLiveFinalizationChunk> {
    let (in_flight_chunk, mut pending_samples, mut pending_microphone, mut pending_system) = {
        let mut state = runtime.audio_state.lock().unwrap();
        (
            state.in_flight_chunk.take(),
            std::mem::take(&mut state.pending_samples),
            std::mem::take(&mut state.pending_microphone_samples),
            std::mem::take(&mut state.pending_system_audio_samples),
        )
    };

    if let Some(tail_samples) = tail_samples {
        append_full_system_stop_tail_samples(
            &mut pending_samples,
            &mut pending_microphone,
            &mut pending_system,
            tail_samples,
        );
    }

    let pending_source_samples = source_samples_from_buffers(pending_microphone, pending_system);
    if !pending_source_samples.is_empty() {
        pending_samples = mixed_samples_from_source_samples(&pending_source_samples);
    }
    let pending_chunk = FullSystemLiveChunk {
        mixed_samples: pending_samples,
        source_samples: pending_source_samples,
    };

    let mut chunks = Vec::with_capacity(2);
    if let Some(in_flight) = in_flight_chunk.filter(|in_flight| !in_flight.chunk.is_empty()) {
        chunks.push(FullSystemLiveFinalizationChunk {
            chunk: in_flight.chunk,
            record_samples: false,
            transcription_task: Some(in_flight.transcription_task),
        });
    }
    if !pending_chunk.is_empty() {
        chunks.push(FullSystemLiveFinalizationChunk {
            chunk: pending_chunk,
            record_samples: true,
            transcription_task: None,
        });
    }
    chunks
}

fn emit_live_session_summary_state(
    app: &AppHandle,
    chunk_count: u64,
    summary_text: Option<String>,
    summary_error: Option<String>,
) {
    let (subtitle, body) = match (summary_text, summary_error) {
        (Some(summary), _) if !summary.trim().is_empty() => (
            "Capturing system audio and microphone audio.".to_string(),
            Some(summary),
        ),
        (_, Some(error)) => (
            "Capturing audio. Live summary is unavailable.".to_string(),
            Some(error),
        ),
        _ => (
            "Capturing system audio and microphone audio.".to_string(),
            None,
        ),
    };

    emit_session_window_state(
        app,
        SessionWindowStatePayload {
            stage: "active".to_string(),
            title: "Live session".to_string(),
            subtitle,
            progress_label: format!("Chunk {} summarized", chunk_count),
            progress_value: 0.0,
            summary_text: body,
            raw_transcript_text: None,
            history_entry_id: None,
        },
    );
}

fn emit_live_session_transcribed_state(
    app: &AppHandle,
    chunk_count: u64,
    summary_text: Option<String>,
    summary_error: Option<String>,
) {
    let (subtitle, body) = match (summary_text, summary_error) {
        (Some(summary), _) if !summary.trim().is_empty() => (
            "Capturing system audio and microphone audio.".to_string(),
            Some(summary),
        ),
        (_, Some(error)) => (
            "Capturing audio. Live summary is unavailable.".to_string(),
            Some(error),
        ),
        _ => (
            "Capturing system audio and microphone audio.".to_string(),
            None,
        ),
    };

    emit_session_window_state(
        app,
        SessionWindowStatePayload {
            stage: "active".to_string(),
            title: "Live session".to_string(),
            subtitle,
            progress_label: format!("Transcribed chunk {}", chunk_count),
            progress_value: 0.0,
            summary_text: body,
            raw_transcript_text: None,
            history_entry_id: None,
        },
    );
}

fn should_update_live_summary(completed_chunk: u64, is_final_chunk: bool) -> bool {
    is_final_chunk || completed_chunk % FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL == 0
}

fn openai_summary_provider(settings: &AppSettings) -> Option<PostProcessProvider> {
    settings
        .post_process_provider("openai")
        .cloned()
        .or_else(|| {
            settings
                .post_process_providers
                .iter()
                .find(|provider| provider.id == "openai")
                .cloned()
        })
}

#[derive(Debug)]
struct LiveSummaryResult {
    summary: String,
    provider_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct MeetingSummaryState {
    current_gist: String,
    #[serde(default)]
    key_points: Vec<SummaryPoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SummaryPoint {
    #[serde(default)]
    text: String,
    #[serde(default)]
    details: Vec<String>,
}

fn meeting_summary_prompt_contract() -> &'static str {
    r#"Return valid JSON only. Do not include markdown, code fences, commentary, or extra fields.

Use exactly this shape:
{
  "current_gist": "one to three concise sentences",
  "key_points": [
    {
      "text": "short topic or important discussion point",
      "details": [
        "expanded supporting detail, tradeoff, rationale, or context from the transcript",
        "another concrete detail when useful"
      ]
    }
  ]
}

Rendered sections must map only to: Current gist, Key points."#
}

fn build_live_summary_prompt(transcript_text: &str, previous_summary: Option<String>) -> String {
    let previous = previous_summary
        .filter(|summary| !summary.trim().is_empty())
        .unwrap_or_else(|| "No previous summary yet.".to_string());
    format!(
        "Update the live meeting summary incrementally.\n\nRules:\n- Use only facts supported by the transcript.\n- Do not invent decisions, tasks, names, deadlines, or speakers.\n- Preserve useful existing information.\n- Merge duplicates.\n- Use only Current gist and Key points.\n- Do not include action items, timelines, decisions, open questions, or raw transcript.\n- Make key points more expanded than terse bullets: use short topic bullets with one to three concrete supporting details when the transcript supports them.\n- Keep the gist concise and keep key point detail readable in a desktop meeting UI.\n\nPrevious rendered summary:\n{}\n\nTranscript so far:\n{}\n\n{}",
        previous,
        transcript_text,
        meeting_summary_prompt_contract()
    )
}

fn extract_json_object(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let without_fence = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);

    let start = without_fence.find('{')?;
    let end = without_fence.rfind('}')?;
    (start <= end).then_some(&without_fence[start..=end])
}

fn parse_meeting_summary_state(text: &str) -> Option<MeetingSummaryState> {
    let json = extract_json_object(text)?;
    let mut state: MeetingSummaryState = serde_json::from_str(json).ok()?;
    state.current_gist = state.current_gist.trim().to_string();
    state.key_points.iter_mut().for_each(|item| {
        item.text = item.text.trim().to_string();
        item.details = item
            .details
            .iter()
            .map(|detail| detail.trim().to_string())
            .filter(|detail| !detail.is_empty())
            .collect();
    });
    state
        .key_points
        .retain(|item| !item.text.is_empty() || !item.details.is_empty());

    (!state.current_gist.is_empty() || !state.key_points.is_empty()).then_some(state)
}

fn render_meeting_summary_markdown(state: &MeetingSummaryState) -> String {
    let mut output = String::new();
    output.push_str("## Current gist\n");
    output.push_str(if state.current_gist.trim().is_empty() {
        "No clear gist yet."
    } else {
        state.current_gist.trim()
    });
    output.push_str("\n\n## Key points\n");
    if state.key_points.is_empty() {
        output.push_str("- None yet.\n");
    } else {
        for point in &state.key_points {
            let text = point.text.trim();
            if !text.is_empty() {
                output.push_str("- ");
                output.push_str(text);
                output.push('\n');
            }
            for detail in &point.details {
                let detail = detail.trim();
                if !detail.is_empty() {
                    output.push_str("  - ");
                    output.push_str(detail);
                    output.push('\n');
                }
            }
        }
    }

    output.trim().to_string()
}

fn normalize_live_summary_output(raw_summary: &str, previous_summary: Option<&str>) -> String {
    if let Some(state) = parse_meeting_summary_state(raw_summary) {
        return render_meeting_summary_markdown(&state);
    }

    previous_summary
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .unwrap_or_else(|| raw_summary.trim())
        .to_string()
}

async fn ensure_backend_summary_install_token(app: &AppHandle) -> Result<String, String> {
    let settings = get_settings(app);
    if settings.install_token.trim().is_empty() {
        bootstrap_install_state(app).await?;
    } else {
        refresh_entitlement_state(app).await?;
    }

    let refreshed = get_settings(app);
    let install_token = refreshed.install_token.trim();
    if install_token.is_empty() {
        return Err("Install token is required for backend summaries.".to_string());
    }

    Ok(install_token.to_string())
}

async fn summarize_live_session(
    app: &AppHandle,
    transcript_text: &str,
    previous_summary: Option<String>,
    chunk_count: u64,
) -> Result<LiveSummaryResult, String> {
    let previous_summary_for_backend = previous_summary.clone();
    let prompt = build_live_summary_prompt(transcript_text, previous_summary);

    match summary_client::summarize_with_codex_app(
        prompt.clone(),
        FULL_SYSTEM_SUMMARY_SYSTEM_PROMPT.to_string(),
    )
    .await
    {
        Ok(summary) => {
            return Ok(LiveSummaryResult {
                summary: normalize_live_summary_output(
                    &summary,
                    previous_summary_for_backend.as_deref(),
                ),
                provider_label: "Codex".to_string(),
            });
        }
        Err(error) => summary_client::summarize_codex_unavailable(&error),
    }

    let settings = get_settings(app);
    if let Some(provider) = openai_summary_provider(&settings) {
        if let Some(api_key) = byok_secrets::load_openai_api_key(app, &settings)? {
            let model = settings
                .post_process_models
                .get("openai")
                .map(|model| model.trim())
                .filter(|model| !model.is_empty())
                .unwrap_or(FULL_SYSTEM_SUMMARY_MODEL_FALLBACK);
            let summary = summary_client::summarize_with_provider(
                &provider,
                api_key,
                model,
                prompt.clone(),
                FULL_SYSTEM_SUMMARY_SYSTEM_PROMPT,
            )
            .await?;

            return Ok(LiveSummaryResult {
                summary: normalize_live_summary_output(
                    &summary,
                    previous_summary_for_backend.as_deref(),
                ),
                provider_label: "OpenAI BYOK".to_string(),
            });
        }
    }

    let install_token = ensure_backend_summary_install_token(app).await?;
    let result = summary_client::summarize_with_backend(
        &install_token,
        transcript_text,
        previous_summary_for_backend.as_deref(),
        chunk_count,
    )
    .await?;

    let mut settings = get_settings(app);
    settings.anonymous_trial_state = result.trial_state;
    settings.access_state = result.access_state;
    settings.entitlement_state = result.entitlement_state;
    write_settings(app, settings);

    Ok(LiveSummaryResult {
        summary: normalize_live_summary_output(
            &result.summary,
            previous_summary_for_backend.as_deref(),
        ),
        provider_label: "Uttr backend".to_string(),
    })
}

async fn summarize_live_session_with_timeout(
    app: &AppHandle,
    transcript_text: &str,
    previous_summary: Option<String>,
    chunk_count: u64,
) -> Result<LiveSummaryResult, String> {
    match timeout(
        FULL_SYSTEM_LIVE_SUMMARY_TIMEOUT,
        summarize_live_session(app, transcript_text, previous_summary, chunk_count),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Live summary timed out after {}s",
            FULL_SYSTEM_LIVE_SUMMARY_TIMEOUT.as_secs()
        )),
    }
}

const ASK_SELECTION_SYSTEM_PROMPT: &str = "You answer a spoken request. If selected text is provided, use it as context; otherwise answer the request directly like a chat question. Return only the answer. Do not replace, rewrite, or quote selected text unless the request asks for that. Do not explain your process, wrap in markdown fences, or include labels.";

fn ask_selection_message(
    role: impl Into<String>,
    text: impl Into<String>,
    pending: bool,
) -> utils::AskSelectionMessage {
    utils::AskSelectionMessage {
        role: role.into(),
        text: text.into(),
        pending,
    }
}

fn ask_selection_payload(
    state: &str,
    session_id: Option<u64>,
    messages: Vec<utils::AskSelectionMessage>,
    text: Option<String>,
    error: Option<String>,
) -> utils::AskSelectionPayload {
    let selected_text = session_id.and_then(current_ask_selection_selected_text);
    utils::AskSelectionPayload {
        state: state.to_string(),
        text,
        selected_text,
        error,
        session_id,
        messages,
    }
}

fn current_ask_selection_session_id() -> u64 {
    ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.id))
        .unwrap_or_else(|| ASK_SELECTION_CHAT_SESSION_ID.fetch_add(1, Ordering::Relaxed))
}

pub fn clear_ask_selection_session() {
    if let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() {
        *session = None;
    }
}

fn update_ask_selection_session(
    session_id: u64,
    owner_operation_id: Option<OperationId>,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
) {
    if let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() {
        *session = Some(AskSelectionChatSession {
            id: session_id,
            owner_operation_id,
            selected_text,
            context,
            messages,
        });
    }
}

fn publish_new_ask_selection_session_if_active<F>(
    operation_id: OperationId,
    session_id: u64,
    owner_operation_id: Option<OperationId>,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
    publish_ui: F,
) -> bool
where
    F: FnOnce(),
{
    let operation_states = DICTATION_OPERATION_TERMINAL_STATES.lock().unwrap();
    if operation_states.contains_key(&operation_id) {
        return false;
    }
    let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() else {
        return false;
    };
    if session.is_some() {
        return false;
    }

    *session = Some(AskSelectionChatSession {
        id: session_id,
        owner_operation_id,
        selected_text,
        context,
        messages,
    });
    publish_ui();
    drop(session);
    drop(operation_states);
    true
}

fn complete_ask_selection_session_if_active<F>(
    operation_id: OperationId,
    session_id: u64,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
    publish_ui: F,
) -> bool
where
    F: FnOnce(),
{
    let mut operation_states = DICTATION_OPERATION_TERMINAL_STATES.lock().unwrap();
    if operation_states.contains_key(&operation_id) {
        return false;
    }
    let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() else {
        return false;
    };
    if !matches!(
        session.as_ref(),
        Some(active)
            if active.id == session_id
                && active.owner_operation_id == Some(operation_id)
    ) {
        return false;
    }

    insert_dictation_operation_terminal_state(
        &mut operation_states,
        operation_id,
        DictationOperationTerminalState::Completed,
    );
    *session = Some(AskSelectionChatSession {
        id: session_id,
        owner_operation_id: None,
        selected_text,
        context,
        messages,
    });
    publish_ui();
    drop(session);
    drop(operation_states);
    true
}

fn publish_new_ask_selection_terminal_error_if_active<F>(
    operation_id: OperationId,
    session_id: u64,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
    publish_ui: F,
) -> bool
where
    F: FnOnce(),
{
    let mut operation_states = DICTATION_OPERATION_TERMINAL_STATES.lock().unwrap();
    if operation_states.contains_key(&operation_id) {
        return false;
    }
    let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() else {
        return false;
    };
    if session.is_some() {
        return false;
    }

    insert_dictation_operation_terminal_state(
        &mut operation_states,
        operation_id,
        DictationOperationTerminalState::Completed,
    );
    *session = Some(AskSelectionChatSession {
        id: session_id,
        owner_operation_id: None,
        selected_text,
        context,
        messages,
    });
    publish_ui();
    true
}

fn complete_ask_selection_session_with_rollback<F>(
    history_manager: &HistoryManager,
    persisted_entry_id: Option<i64>,
    operation_id: OperationId,
    session_id: u64,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
    publish_ui: F,
) -> bool
where
    F: FnOnce(),
{
    let committed = complete_ask_selection_session_if_active(
        operation_id,
        session_id,
        selected_text,
        context,
        messages,
        publish_ui,
    );
    if !committed {
        rollback_cancelled_dictation_history(history_manager, persisted_entry_id);
    }
    committed
}

fn show_new_ask_selection_error_if_active(
    app: &AppHandle,
    operation_id: OperationId,
    context: &AppContextSnapshot,
    message: String,
) -> bool {
    let session_id = current_ask_selection_session_id();
    let messages = current_ask_selection_messages();
    let payload = ask_selection_payload(
        "error",
        Some(session_id),
        messages.clone(),
        None,
        Some(message),
    );
    publish_new_ask_selection_terminal_error_if_active(
        operation_id,
        session_id,
        context.selected_text.clone(),
        context.clone(),
        messages,
        || utils::show_ask_selection_panel(app, payload),
    )
}

fn cancel_ask_selection_session_if_owned<F>(operation_id: OperationId, cancel_ui: F) -> bool
where
    F: FnOnce(),
{
    let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() else {
        return false;
    };
    if !matches!(
        session.as_ref(),
        Some(active) if active.owner_operation_id == Some(operation_id)
    ) {
        return false;
    }

    *session = None;
    cancel_ui();
    true
}

pub fn cancel_ask_selection_operation(app: &AppHandle, operation_id: OperationId) -> bool {
    cancel_ask_selection_session_if_owned(operation_id, || {
        // The ownership lock remains held until the hide is queued. A newer
        // session cannot publish its show request between these two actions.
        utils::hide_ask_selection_panel(app);
    })
}

fn current_ask_selection_messages() -> Vec<utils::AskSelectionMessage> {
    ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.messages.clone()))
        .unwrap_or_default()
}

fn current_ask_selection_selected_text(session_id: u64) -> Option<String> {
    ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| {
            session
                .as_ref()
                .filter(|session| session.id == session_id)
                .and_then(|session| session.selected_text.clone())
        })
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn ask_selection_session_is_current(session_id: u64) -> bool {
    ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.id == session_id))
        .unwrap_or(false)
}

fn build_ask_selection_prompt(
    selected_text: &str,
    spoken_instruction: &str,
    context: &AppContextSnapshot,
    custom_vocabulary_terms: &[String],
) -> String {
    let selected_text = selected_text.trim();
    let mut prompt = if selected_text.is_empty() {
        format!(
            "# Task\nAnswer the spoken request directly as a chat question. No selected text was provided. Return only the answer inside <uttr_ask_output>...</uttr_ask_output>.\n\n# Spoken request\n{}",
            spoken_instruction.trim()
        )
    } else {
        format!(
            "# Task\nAnswer the spoken request using the selected text as context. Return only the answer inside <uttr_ask_output>...</uttr_ask_output>. Do not modify the user's selected text or produce replacement text unless the spoken request explicitly asks for a rewrite.\n\n# Spoken request\n{}\n\n# Selected text\n{}",
            spoken_instruction.trim(),
            selected_text
        )
    };

    if let Some(block) = app_context_prompt_block(context) {
        prompt.push_str("\n\n# Context\n");
        prompt.push_str(&block);
    }
    if let Some(block) = custom_vocabulary_prompt_block(custom_vocabulary_terms) {
        prompt.push_str("\n\n# Custom vocabulary\n");
        prompt.push_str(&block);
    }

    prompt.push_str("\n\n# Output format\n<uttr_ask_output>\n...\n</uttr_ask_output>");
    prompt
}

fn render_ask_selection_conversation(messages: &[utils::AskSelectionMessage]) -> String {
    messages
        .iter()
        .filter(|message| !message.pending && !message.text.trim().is_empty())
        .map(|message| {
            let role = match message.role.as_str() {
                "assistant" => "Assistant",
                "user" => "User",
                _ => "Message",
            };
            format!("{}: {}", role, message.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_ask_selection_follow_up_prompt(
    selected_text: &str,
    messages: &[utils::AskSelectionMessage],
    follow_up: &str,
    context: &AppContextSnapshot,
    custom_vocabulary_terms: &[String],
) -> String {
    let conversation = render_ask_selection_conversation(messages);
    let selected_text = selected_text.trim();
    let mut prompt = format!(
        "# Task\nAnswer the latest follow-up using the prior Ask Selection chat as context. Return only the answer inside <uttr_ask_output>...</uttr_ask_output>. Answer the latest follow-up using the prior chat first. Use the original selected text only as background if it is still relevant.\n\n# Latest follow-up\n{}",
        follow_up.trim()
    );

    if !conversation.trim().is_empty() {
        prompt.push_str("\n\n# Prior chat\n");
        prompt.push_str(&conversation);
    }
    if !selected_text.is_empty() {
        prompt.push_str("\n\n# Original selected text\n");
        prompt.push_str(selected_text);
    }
    if let Some(block) = app_context_prompt_block(context) {
        prompt.push_str("\n\n# Context\n");
        prompt.push_str(&block);
    }
    if let Some(block) = custom_vocabulary_prompt_block(custom_vocabulary_terms) {
        prompt.push_str("\n\n# Custom vocabulary\n");
        prompt.push_str(&block);
    }

    prompt.push_str("\n\n# Output format\n<uttr_ask_output>\n...\n</uttr_ask_output>");
    prompt
}

fn clean_ask_selection_response(content: &str) -> String {
    if let Some(output) = extract_tagged_output(content, "uttr_ask_output") {
        return strip_wrapping_code_fence(&trim_chat_stop_tokens(&output));
    }

    clean_post_process_response(content)
}

async fn run_ask_selection_prompt(
    app_handle: &AppHandle,
    settings: &AppSettings,
    prompt: String,
) -> Result<(String, String), String> {
    let provider_error =
        match run_ask_selection_provider_prompt(app_handle, settings, prompt.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                warn!(
                    "Ask Selection provider route failed; falling back to Codex app-server: {}",
                    error
                );
                error
            }
        };

    match summary_client::transform_with_codex_app(prompt, ASK_SELECTION_SYSTEM_PROMPT.to_string())
        .await
    {
        Ok(output) => {
            let output = clean_ask_selection_response(&output);
            if output.trim().is_empty() {
                return Err("Codex returned an empty Ask Selection answer.".to_string());
            }
            Ok((output, "Ask Selection via Codex app-server".to_string()))
        }
        Err(error) => {
            summary_client::summarize_codex_unavailable(&error);
            Err(format!(
                "Ask Selection provider and Codex fallback both failed. Provider: {}. Codex fallback: {}",
                provider_error, error
            ))
        }
    }
}

async fn run_ask_selection_provider_prompt(
    app_handle: &AppHandle,
    settings: &AppSettings,
    prompt: String,
) -> Result<(String, String), String> {
    let provider = settings
        .active_post_process_provider()
        .cloned()
        .ok_or_else(|| "Ask Selection needs a post-processing provider.".to_string())?;

    let api_key =
        match crate::byok_secrets::load_provider_api_key(app_handle, settings, &provider.id) {
            Ok(Some(key)) => key,
            Ok(None) => String::new(),
            Err(error) => {
                warn!(
                    "Failed to load API key for edit provider '{}': {}",
                    provider.id, error
                );
                String::new()
            }
        };

    let model = resolve_post_process_model(&provider, settings, &api_key)
        .await
        .ok_or_else(|| "Ask Selection could not resolve a post-processing model.".to_string())?;

    crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        prompt,
        Some(ASK_SELECTION_SYSTEM_PROMPT),
    )
    .await?
    .map(|content| {
        (
            clean_ask_selection_response(&content),
            format!("Ask Selection via {}", provider.label),
        )
    })
    .filter(|(output, _)| !output.trim().is_empty())
    .ok_or_else(|| "Ask Selection provider returned an empty answer.".to_string())
}

async fn answer_ask_selection(
    app_handle: &AppHandle,
    settings: &AppSettings,
    selected_text: &str,
    spoken_instruction: &str,
    context: &AppContextSnapshot,
) -> Result<(String, String), String> {
    let prompt = build_ask_selection_prompt(
        selected_text,
        spoken_instruction,
        context,
        &settings.custom_vocabulary_terms,
    );

    run_ask_selection_prompt(app_handle, settings, prompt).await
}

pub async fn answer_ask_selection_follow_up(
    app_handle: AppHandle,
    session_id: u64,
    message: String,
) -> Result<utils::AskSelectionPayload, String> {
    let follow_up = message.trim().to_string();
    if follow_up.is_empty() {
        return Err("Ask Selection follow-up cannot be empty.".to_string());
    }

    let mut session = ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| session.clone())
        .ok_or_else(|| "Ask Selection session is no longer available.".to_string())?;
    if session.id != session_id {
        return Err(
            "Ask Selection session is stale. Start a new Ask Selection request.".to_string(),
        );
    }
    let selected_text = session
        .selected_text
        .clone()
        .filter(|text| !text.trim().is_empty());

    session
        .messages
        .push(ask_selection_message("user", follow_up.clone(), false));
    let pending_messages = {
        let mut messages = session.messages.clone();
        messages.push(ask_selection_message("assistant", "Thinking...", true));
        messages
    };
    update_ask_selection_session(
        session.id,
        session.owner_operation_id,
        selected_text.clone(),
        session.context.clone(),
        pending_messages.clone(),
    );
    utils::update_ask_selection_panel(
        &app_handle,
        ask_selection_payload("thinking", Some(session.id), pending_messages, None, None),
    );

    let settings = get_settings(&app_handle);
    let prompt = build_ask_selection_follow_up_prompt(
        selected_text.as_deref().unwrap_or(""),
        &session.messages,
        &follow_up,
        &session.context,
        &settings.custom_vocabulary_terms,
    );

    match run_ask_selection_prompt(&app_handle, &settings, prompt).await {
        Ok((answer, _prompt_label)) => {
            if !ask_selection_session_is_current(session.id) {
                return Err("Ask Selection session is no longer available.".to_string());
            }
            session
                .messages
                .push(ask_selection_message("assistant", answer.clone(), false));
            update_ask_selection_session(
                session.id,
                None,
                selected_text,
                session.context,
                session.messages.clone(),
            );
            let payload = ask_selection_payload(
                "result",
                Some(session.id),
                session.messages,
                Some(answer),
                None,
            );
            utils::update_ask_selection_panel(&app_handle, payload.clone());
            Ok(payload)
        }
        Err(error) => {
            if !ask_selection_session_is_current(session.id) {
                return Err("Ask Selection session is no longer available.".to_string());
            }
            let payload = ask_selection_payload(
                "error",
                Some(session.id),
                session.messages,
                None,
                Some(error.clone()),
            );
            utils::update_ask_selection_panel(&app_handle, payload.clone());
            Err(error)
        }
    }
}

fn friendly_live_summary_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();

    if lower.contains("insufficient_quota") || lower.contains("current quota") {
        return "OpenAI quota is exhausted for the saved API key. Recording continues, but live summaries are paused for this session.".to_string();
    }

    if lower.contains("status 429") || lower.contains("too many requests") {
        return "OpenAI is rate limiting live summaries. Recording continues, but live summaries are paused for this session.".to_string();
    }

    if lower.contains("status 401")
        || lower.contains("invalid_api_key")
        || lower.contains("incorrect api key")
        || lower.contains("unauthorized")
    {
        return "The saved OpenAI API key was rejected. Recording continues, but live summaries are paused for this session.".to_string();
    }

    if lower.contains("status 403") || lower.contains("forbidden") {
        return "The saved OpenAI API key does not have access to live summaries. Recording continues, but summaries are paused for this session.".to_string();
    }

    if lower.contains("api key") && lower.contains("settings") {
        return error.to_string();
    }

    "OpenAI could not update the live summary. Recording continues.".to_string()
}

fn should_pause_live_summaries(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("insufficient_quota")
        || lower.contains("current quota")
        || lower.contains("status 429")
        || lower.contains("too many requests")
        || lower.contains("status 401")
        || lower.contains("invalid_api_key")
        || lower.contains("incorrect api key")
        || lower.contains("unauthorized")
        || lower.contains("status 403")
        || lower.contains("forbidden")
        || (lower.contains("api key") && lower.contains("settings"))
}

fn spawn_full_system_live_transcription_task(
    tm: Arc<TranscriptionManager>,
    chunk: FullSystemLiveChunk,
    chunk_index: u64,
) -> FullSystemLiveTranscriptionTask {
    Arc::new(tokio::sync::Mutex::new(tauri::async_runtime::spawn(
        async move { transcribe_full_system_live_chunk_sources(&tm, chunk, chunk_index).await },
    )))
}

async fn await_full_system_live_transcription_task(
    transcription_task: &FullSystemLiveTranscriptionTask,
) -> Result<Vec<LabeledTranscriptSegment>, anyhow::Error> {
    let mut task = transcription_task.lock().await;
    match (&mut *task).await {
        Ok(result) => result,
        Err(error) => Err(anyhow::anyhow!(
            "Live transcription task failed to join: {}",
            error
        )),
    }
}

fn reap_full_system_live_transcription_task(transcription_task: FullSystemLiveTranscriptionTask) {
    tauri::async_runtime::spawn(async move {
        match await_full_system_live_transcription_task(&transcription_task).await {
            Ok(_) => {
                warn!("Discarding live transcription that completed after the finalization timeout")
            }
            Err(error) => warn!(
                "Late live transcription finished with an error after finalization timeout: {}",
                error
            ),
        }
    });
}

fn mark_full_system_live_transcription_failure(runtime: &FullSystemLiveRuntime, timed_out: bool) {
    let notice = if timed_out {
        runtime
            .final_transcription_timed_out
            .store(true, Ordering::Relaxed);
        FINAL_TRANSCRIPTION_TIMEOUT_NOTICE
    } else {
        runtime
            .final_transcription_failed
            .store(true, Ordering::Relaxed);
        TRANSCRIPTION_FAILURE_NOTICE
    };

    let mut summary_text = runtime.summary_text.lock().unwrap();
    if summary_text
        .as_deref()
        .is_some_and(|summary| summary.contains(notice))
    {
        return;
    }
    let existing_summary = summary_text.take();
    *summary_text = Some(
        existing_summary
            .filter(|summary| !summary.trim().is_empty())
            .map(|summary| format!("{}\n\n{}", notice, summary))
            .unwrap_or_else(|| notice.to_string()),
    );
}

async fn transcribe_and_summarize_live_chunk(
    app: &AppHandle,
    runtime: &Arc<FullSystemLiveRuntime>,
    tm: &Arc<TranscriptionManager>,
    chunk: FullSystemLiveChunk,
    is_final_chunk: bool,
    record_samples: bool,
    tracked_in_flight: bool,
    transcription_task: Option<FullSystemLiveTranscriptionTask>,
    transcription_timeout: Option<Duration>,
) -> bool {
    if chunk.is_empty() {
        if tracked_in_flight {
            clear_full_system_live_in_flight_chunk(runtime);
        }
        return true;
    }

    if record_samples {
        record_full_system_live_chunk_samples(runtime, &chunk);
    }

    let chunk_index = runtime.chunk_count.load(Ordering::Relaxed) + 1;
    if is_final_chunk {
        emit_session_window_state(
            app,
            SessionWindowStatePayload {
                stage: "transcribing".to_string(),
                title: "Preparing summary".to_string(),
                subtitle: "Finishing the final audio chunk.".to_string(),
                progress_label: "Transcribing final chunk".to_string(),
                progress_value: 0.72,
                summary_text: runtime.summary_text.lock().unwrap().clone(),
                raw_transcript_text: None,
                history_entry_id: None,
            },
        );
    } else if !runtime.stop_requested.load(Ordering::Relaxed) {
        emit_session_window_state(
            app,
            SessionWindowStatePayload {
                stage: "active".to_string(),
                title: "Live session".to_string(),
                subtitle: "Capturing system audio and microphone audio.".to_string(),
                progress_label: format!("Transcribing chunk {}", chunk_index),
                progress_value: 0.0,
                summary_text: runtime.summary_text.lock().unwrap().clone(),
                raw_transcript_text: None,
                history_entry_id: None,
            },
        );
    }

    let transcription_task = transcription_task.unwrap_or_else(|| {
        spawn_full_system_live_transcription_task(Arc::clone(tm), chunk.clone(), chunk_index)
    });
    let (transcription_result, timed_out) = if let Some(timeout_duration) = transcription_timeout {
        match timeout(
            timeout_duration,
            await_full_system_live_transcription_task(&transcription_task),
        )
        .await
        {
            Ok(result) => (result, false),
            Err(_) => {
                reap_full_system_live_transcription_task(Arc::clone(&transcription_task));
                (
                    Err(anyhow::anyhow!(
                        "Live chunk transcription timed out after {}s; audio was saved",
                        timeout_duration.as_secs()
                    )),
                    true,
                )
            }
        }
    } else {
        (
            await_full_system_live_transcription_task(&transcription_task).await,
            false,
        )
    };

    let transcription_segments = match transcription_result {
        Ok(segments) => segments,
        Err(error) => {
            mark_full_system_live_transcription_failure(runtime, timed_out);
            if tracked_in_flight {
                clear_full_system_live_in_flight_chunk(runtime);
            }
            warn!(
                "Live full-system chunk {} transcription failed: {}",
                chunk_index, error
            );
            *runtime.summary_error.lock().unwrap() = Some(format!(
                "Live transcription failed for chunk {}: {}",
                chunk_index, error
            ));
            if is_final_chunk {
                emit_session_window_state(
                    app,
                    SessionWindowStatePayload {
                        stage: "processing".to_string(),
                        title: "Preparing summary".to_string(),
                        subtitle: "Unable to transcribe the final audio chunk.".to_string(),
                        progress_label: "Processing".to_string(),
                        progress_value: 0.88,
                        summary_text: runtime.summary_error.lock().unwrap().clone(),
                        raw_transcript_text: None,
                        history_entry_id: None,
                    },
                );
            } else if !runtime.stop_requested.load(Ordering::Relaxed) {
                emit_live_session_summary_state(
                    app,
                    runtime.chunk_count.load(Ordering::Relaxed),
                    runtime.summary_text.lock().unwrap().clone(),
                    runtime.summary_error.lock().unwrap().clone(),
                );
            }
            return !timed_out;
        }
    };

    let committed = commit_full_system_live_transcription_segments(
        runtime,
        &transcription_segments,
        tracked_in_flight,
    );

    if transcription_segments.is_empty() {
        if is_final_chunk {
            let transcript_so_far = runtime.transcript_text.lock().unwrap().clone();
            if !transcript_so_far.trim().is_empty()
                && !runtime.summary_disabled.load(Ordering::Relaxed)
            {
                emit_session_window_state(
                    app,
                    SessionWindowStatePayload {
                        stage: "processing".to_string(),
                        title: "Preparing summary".to_string(),
                        subtitle: "Updating the final summary.".to_string(),
                        progress_label: "Summarizing final chunk".to_string(),
                        progress_value: 0.88,
                        summary_text: runtime.summary_text.lock().unwrap().clone(),
                        raw_transcript_text: None,
                        history_entry_id: None,
                    },
                );

                let previous_summary = runtime.summary_text.lock().unwrap().clone();
                let completed_chunk = runtime.chunk_count.load(Ordering::Relaxed).max(1);
                match summarize_live_session_with_timeout(
                    app,
                    &transcript_so_far,
                    previous_summary,
                    completed_chunk,
                )
                .await
                {
                    Ok(result) => {
                        let summary = result.summary;
                        *runtime.summary_text.lock().unwrap() = Some(summary.clone());
                        *runtime.summary_provider.lock().unwrap() = Some(result.provider_label);
                        *runtime.summary_error.lock().unwrap() = None;
                        emit_session_window_state(
                            app,
                            SessionWindowStatePayload {
                                stage: "processing".to_string(),
                                title: "Preparing summary".to_string(),
                                subtitle: "Saving the session.".to_string(),
                                progress_label: "Saving".to_string(),
                                progress_value: 0.92,
                                summary_text: Some(summary),
                                raw_transcript_text: None,
                                history_entry_id: None,
                            },
                        );
                    }
                    Err(error) => {
                        let message = friendly_live_summary_error(&error);
                        if should_pause_live_summaries(&error) {
                            runtime.summary_disabled.store(true, Ordering::Relaxed);
                        }
                        *runtime.summary_error.lock().unwrap() = Some(message);
                        emit_session_window_state(
                            app,
                            SessionWindowStatePayload {
                                stage: "processing".to_string(),
                                title: "Preparing summary".to_string(),
                                subtitle: "Saving the session without a final summary update."
                                    .to_string(),
                                progress_label: "Saving".to_string(),
                                progress_value: 0.92,
                                summary_text: runtime.summary_text.lock().unwrap().clone(),
                                raw_transcript_text: None,
                                history_entry_id: None,
                            },
                        );
                    }
                }
            }
        }
        return true;
    }

    if let Some((transcript_so_far, completed_chunk)) = committed {
        if !should_update_live_summary(completed_chunk, is_final_chunk) {
            if !runtime.stop_requested.load(Ordering::Relaxed) {
                emit_live_session_transcribed_state(
                    app,
                    completed_chunk,
                    runtime.summary_text.lock().unwrap().clone(),
                    runtime.summary_error.lock().unwrap().clone(),
                );
            }
            return true;
        }

        if runtime.summary_disabled.load(Ordering::Relaxed) {
            if is_final_chunk {
                emit_session_window_state(
                    app,
                    SessionWindowStatePayload {
                        stage: "processing".to_string(),
                        title: "Preparing summary".to_string(),
                        subtitle: "Saving the session.".to_string(),
                        progress_label: "Processing".to_string(),
                        progress_value: 0.88,
                        summary_text: runtime.summary_text.lock().unwrap().clone(),
                        raw_transcript_text: None,
                        history_entry_id: None,
                    },
                );
            } else if !runtime.stop_requested.load(Ordering::Relaxed) {
                emit_live_session_summary_state(
                    app,
                    completed_chunk,
                    runtime.summary_text.lock().unwrap().clone(),
                    runtime.summary_error.lock().unwrap().clone(),
                );
            }
            return true;
        }

        if is_final_chunk {
            emit_session_window_state(
                app,
                SessionWindowStatePayload {
                    stage: "processing".to_string(),
                    title: "Preparing summary".to_string(),
                    subtitle: "Updating the final summary.".to_string(),
                    progress_label: "Summarizing final chunk".to_string(),
                    progress_value: 0.88,
                    summary_text: runtime.summary_text.lock().unwrap().clone(),
                    raw_transcript_text: None,
                    history_entry_id: None,
                },
            );
        } else if !runtime.stop_requested.load(Ordering::Relaxed) {
            emit_session_window_state(
                app,
                SessionWindowStatePayload {
                    stage: "active".to_string(),
                    title: "Live session".to_string(),
                    subtitle: "Capturing system audio and microphone audio.".to_string(),
                    progress_label: format!("Summarizing chunk {}", completed_chunk),
                    progress_value: 0.0,
                    summary_text: runtime.summary_text.lock().unwrap().clone(),
                    raw_transcript_text: None,
                    history_entry_id: None,
                },
            );
        }

        let previous_summary = runtime.summary_text.lock().unwrap().clone();
        match summarize_live_session_with_timeout(
            app,
            &transcript_so_far,
            previous_summary,
            completed_chunk,
        )
        .await
        {
            Ok(result) => {
                let summary = result.summary;
                *runtime.summary_text.lock().unwrap() = Some(summary.clone());
                *runtime.summary_provider.lock().unwrap() = Some(result.provider_label);
                *runtime.summary_error.lock().unwrap() = None;
                if is_final_chunk {
                    emit_session_window_state(
                        app,
                        SessionWindowStatePayload {
                            stage: "processing".to_string(),
                            title: "Preparing summary".to_string(),
                            subtitle: "Saving the session.".to_string(),
                            progress_label: "Saving".to_string(),
                            progress_value: 0.92,
                            summary_text: Some(summary),
                            raw_transcript_text: None,
                            history_entry_id: None,
                        },
                    );
                } else if !runtime.stop_requested.load(Ordering::Relaxed) {
                    emit_live_session_summary_state(app, completed_chunk, Some(summary), None);
                }
            }
            Err(error) => {
                let message = friendly_live_summary_error(&error);
                if should_pause_live_summaries(&error) {
                    runtime.summary_disabled.store(true, Ordering::Relaxed);
                }
                *runtime.summary_error.lock().unwrap() = Some(message.clone());
                if is_final_chunk {
                    emit_session_window_state(
                        app,
                        SessionWindowStatePayload {
                            stage: "processing".to_string(),
                            title: "Preparing summary".to_string(),
                            subtitle: "Saving the session without a final summary update."
                                .to_string(),
                            progress_label: "Saving".to_string(),
                            progress_value: 0.92,
                            summary_text: runtime.summary_text.lock().unwrap().clone(),
                            raw_transcript_text: None,
                            history_entry_id: None,
                        },
                    );
                } else if !runtime.stop_requested.load(Ordering::Relaxed) {
                    emit_live_session_summary_state(
                        app,
                        completed_chunk,
                        runtime.summary_text.lock().unwrap().clone(),
                        Some(message),
                    );
                }
            }
        }
    }
    true
}

async fn transcribe_full_system_live_chunk_sources(
    tm: &Arc<TranscriptionManager>,
    chunk: FullSystemLiveChunk,
    chunk_index: u64,
) -> Result<Vec<LabeledTranscriptSegment>, anyhow::Error> {
    transcribe_full_system_live_chunk_sources_with(chunk, chunk_index, |samples, source, _| {
        tm.transcribe_with_source(samples, source)
    })
    .await
}

async fn transcribe_full_system_live_chunk_sources_with<F, Fut>(
    chunk: FullSystemLiveChunk,
    chunk_index: u64,
    mut transcribe: F,
) -> Result<Vec<LabeledTranscriptSegment>, anyhow::Error>
where
    F: FnMut(Vec<f32>, Option<&'static str>, Duration) -> Fut,
    Fut: Future<Output = Result<String, anyhow::Error>>,
{
    let mut segments = Vec::new();
    let mut successful_source_transcriptions = 0usize;
    let mut source_errors = Vec::new();

    if chunk.source_samples.is_empty() {
        let sample_count = chunk.mixed_samples.len();
        let transcription = transcribe(
            chunk.mixed_samples,
            Some("full_system_audio"),
            transcription_timeout_for_samples(sample_count),
        )
        .await?;
        if !transcription.trim().is_empty() {
            return Ok(vec![LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::SystemAudio,
                text: transcription,
            }]);
        }
        return Ok(Vec::new());
    }

    for source_samples in chunk.source_samples {
        if source_samples.samples.is_empty()
            || is_effectively_silent_full_system_source_audio(&source_samples.samples)
        {
            if let Some((rms, peak)) = silent_audio_levels(&source_samples.samples) {
                debug!(
                    "Skipping quiet full-system source chunk source={} chunk={} rms={:.6} peak={:.6}",
                    full_system_source_label(source_samples.source),
                    chunk_index,
                    rms,
                    peak
                );
            }
            continue;
        }

        let source_label = full_system_source_label(source_samples.source);
        let source_id = full_system_source_transcription_id(source_samples.source);
        let sample_count = source_samples.samples.len();
        let started = Instant::now();
        log::info!(
            "[latency] full-system source transcription begin chunk={} source={} sample_count={}",
            chunk_index,
            source_label,
            sample_count
        );
        let transcription_result = transcribe(
            source_samples.samples,
            Some(source_id),
            transcription_timeout_for_samples(sample_count),
        )
        .await;
        match transcription_result {
            Ok(text) => {
                successful_source_transcriptions += 1;
                log::info!(
                    "[latency] full-system source transcription complete chunk={} source={} sample_count={} elapsed_ms={}",
                    chunk_index,
                    source_label,
                    sample_count,
                    started.elapsed().as_millis()
                );

                if !text.trim().is_empty() {
                    segments.push(LabeledTranscriptSegment {
                        source: source_samples.source,
                        text,
                    });
                }
            }
            Err(error) => {
                warn!(
                    "Live full-system source transcription failed chunk={} source={} elapsed_ms={}: {}",
                    chunk_index,
                    source_label,
                    started.elapsed().as_millis(),
                    error
                );
                source_errors.push(format!("{}: {}", source_label, error));
            }
        }
    }

    if successful_source_transcriptions == 0 && !source_errors.is_empty() {
        Err(anyhow::anyhow!(
            "Live source transcription failed for chunk {}: {}",
            chunk_index,
            source_errors.join("; ")
        ))
    } else {
        Ok(segments)
    }
}

fn full_system_live_session_status(binding_id: &str) -> FullSystemLiveSessionStatus {
    let guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
    let Some(session) = guard
        .as_ref()
        .filter(|session| session.binding_id == binding_id)
    else {
        return if FULL_SYSTEM_FINALIZATION_BARRIERS
            .lock()
            .unwrap()
            .keys()
            .any(|(finalizing_binding, _)| finalizing_binding == binding_id)
        {
            FullSystemLiveSessionStatus::Finalizing
        } else {
            FullSystemLiveSessionStatus::Missing
        };
    };

    if session.runtime.stop_requested.load(Ordering::Relaxed)
        || session.worker_handle.inner().is_finished()
    {
        FullSystemLiveSessionStatus::Finalizing
    } else {
        FullSystemLiveSessionStatus::Running
    }
}

fn full_system_live_start_decision(
    binding_id: &str,
    start_result: &FullSystemSessionStartResult,
) -> FullSystemLiveStartDecision {
    let recording_started = start_result.started
        && start_result
            .session
            .as_ref()
            .is_some_and(|session| session.binding_id == binding_id);

    FullSystemLiveStartDecision {
        recording_started,
        initialize_live_runtime: recording_started,
        perform_start_side_effects: recording_started && start_result.new_session_started,
    }
}

fn existing_full_system_live_start_decision(
    binding_id: &str,
    active_session: Option<&FullSystemSessionSnapshot>,
    live_session_status: FullSystemLiveSessionStatus,
) -> Option<FullSystemLiveStartDecision> {
    (live_session_status != FullSystemLiveSessionStatus::Missing).then(|| {
        FullSystemLiveStartDecision {
            recording_started: active_session
                .is_some_and(|session| session.binding_id == binding_id),
            initialize_live_runtime: false,
            perform_start_side_effects: false,
        }
    })
}

fn start_full_system_live_session(app: &AppHandle, binding_id: &str) -> bool {
    let mut guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|session| session.binding_id == binding_id)
    {
        debug!(
            "Preserving existing full-system live runtime for repeated start '{}'",
            binding_id
        );
        return false;
    }

    let runtime = Arc::new(FullSystemLiveRuntime::new());
    let worker_runtime = Arc::clone(&runtime);
    let worker_app = app.clone();
    let worker_binding = binding_id.to_string();
    let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
    let full_system_audio = Arc::clone(&app.state::<Arc<FullSystemAudioSessionManager>>());

    let worker_handle = tauri::async_runtime::spawn(async move {
        while !worker_runtime.stop_requested.load(Ordering::Relaxed) {
            if let Some(delta) = full_system_audio.drain_session_delta_sources(&worker_binding) {
                append_full_system_live_audio_delta(
                    &mut worker_runtime.audio_state.lock().unwrap(),
                    delta,
                );
            }

            while !worker_runtime.stop_requested.load(Ordering::Relaxed) {
                let tm_for_chunk = Arc::clone(&tm);
                let Some(in_flight) =
                    take_next_full_system_live_chunk(&worker_runtime, move |chunk, chunk_index| {
                        spawn_full_system_live_transcription_task(tm_for_chunk, chunk, chunk_index)
                    })
                else {
                    break;
                };
                transcribe_and_summarize_live_chunk(
                    &worker_app,
                    &worker_runtime,
                    &tm,
                    in_flight.chunk,
                    false,
                    true,
                    true,
                    Some(in_flight.transcription_task),
                    None,
                )
                .await;
            }

            sleep(FULL_SYSTEM_LIVE_CHUNK_POLL_INTERVAL).await;
        }
    });

    if let Some(previous) = guard.take() {
        previous
            .runtime
            .stop_requested
            .store(true, Ordering::Relaxed);
        previous.worker_handle.abort();
    }
    *guard = Some(FullSystemLiveSession {
        binding_id: binding_id.to_string(),
        runtime,
        worker_handle,
    });
    true
}

fn signal_full_system_live_session_stop(binding_id: &str) {
    let guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
    if let Some(session) = guard.as_ref() {
        if session.binding_id == binding_id {
            session
                .runtime
                .stop_requested
                .store(true, Ordering::Relaxed);
        }
    }
}

fn append_full_system_live_session_delta(
    binding_id: &str,
    delta: FullSystemSessionTranscriptionSamples,
) {
    let guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
    let Some(session) = guard.as_ref() else {
        return;
    };
    if session.binding_id != binding_id {
        return;
    }

    append_full_system_live_audio_delta(&mut session.runtime.audio_state.lock().unwrap(), delta);
}

async fn await_full_system_live_worker_stop(
    mut worker_handle: JoinHandle<()>,
    timeout_duration: Duration,
) {
    match timeout(timeout_duration, &mut worker_handle).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            warn!("Live full-system worker join error: {}", error);
        }
        Err(_) => {
            warn!(
                "Live full-system worker did not stop within {:?}; aborting outer worker",
                timeout_duration
            );
            worker_handle.abort();
            let _ = worker_handle.await;
        }
    }
}

async fn finish_full_system_live_session(
    app: &AppHandle,
    binding_id: &str,
    tail_samples: Option<FullSystemSessionTranscriptionSamples>,
    tm: Arc<TranscriptionManager>,
) -> Option<FullSystemLiveFinal> {
    let session = {
        let mut guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
        let Some(session) = guard.take() else {
            return None;
        };
        if session.binding_id != binding_id {
            *guard = Some(session);
            return None;
        }
        session
    };

    session
        .runtime
        .stop_requested
        .store(true, Ordering::Relaxed);
    await_full_system_live_worker_stop(session.worker_handle, FULL_SYSTEM_LIVE_WORKER_STOP_TIMEOUT)
        .await;

    let finalization_chunks =
        take_full_system_live_finalization_chunks(&session.runtime, tail_samples);
    record_full_system_live_finalization_audio(&session.runtime, &finalization_chunks);
    let finalization_chunk_count = finalization_chunks.len();
    for (index, finalization) in finalization_chunks.into_iter().enumerate() {
        let is_final_chunk = index + 1 == finalization_chunk_count;
        let final_chunk_timeout = full_system_live_final_chunk_timeout(&finalization.chunk);
        let completed = transcribe_and_summarize_live_chunk(
            app,
            &session.runtime,
            &tm,
            finalization.chunk,
            is_final_chunk,
            false,
            false,
            finalization.transcription_task,
            Some(final_chunk_timeout),
        )
        .await;
        if !completed {
            break;
        }
    }

    snapshot_full_system_live_runtime(&session.runtime)
}

fn append_full_system_stop_tail_samples(
    final_samples: &mut Vec<f32>,
    final_microphone_samples: &mut Vec<f32>,
    final_system_audio_samples: &mut Vec<f32>,
    tail_samples: FullSystemSessionTranscriptionSamples,
) {
    let mut appended_source = false;
    for source_samples in tail_samples.sources {
        if source_samples.samples.is_empty() {
            continue;
        }

        match source_samples.source {
            FullSystemTranscriptionSource::Microphone => {
                final_microphone_samples.extend_from_slice(&source_samples.samples);
            }
            FullSystemTranscriptionSource::SystemAudio => {
                final_system_audio_samples.extend_from_slice(&source_samples.samples);
            }
        }
        appended_source = true;
    }

    if appended_source {
        return;
    }

    if let Some(mixed) = tail_samples.mixed.filter(|samples| !samples.is_empty()) {
        final_samples.extend_from_slice(&mixed);
    }
}

fn mixed_samples_from_source_samples(
    source_samples: &[FullSystemTranscriptionSourceSamples],
) -> Vec<f32> {
    match source_samples {
        [] => Vec::new(),
        [source] => source.samples.clone(),
        sources => {
            let source_refs: Vec<&[f32]> = sources
                .iter()
                .map(|source| source.samples.as_slice())
                .collect();
            mix_transcription_pcm_sources(&source_refs)
        }
    }
}

fn handle_transcription_stop(
    app: &AppHandle,
    binding_id: &str,
    operation_id: OperationId,
    samples: Option<Vec<f32>>,
    recording_duration: Option<Duration>,
    post_process: bool,
    use_incremental: bool,
    completion_mode: TranscriptionCompletionMode,
    completion_context: TranscriptionCompletionContext,
    tm: Arc<TranscriptionManager>,
    hm: Arc<HistoryManager>,
    finish_guard: Option<FinishGuard>,
) {
    log::info!(
        "[latency] transcription task scheduling binding={} sample_count={} recording_duration_ms={}",
        binding_id,
        samples.as_ref().map(|samples| samples.len()).unwrap_or(0),
        recording_duration.unwrap_or_default().as_millis()
    );

    let mut context_snapshot = take_active_context(
        binding_id,
        completion_mode == TranscriptionCompletionMode::EditMode,
    );
    let ah = app.clone();
    let binding_id = binding_id.to_string();
    let task_completed = Arc::new(AtomicBool::new(false));
    let task_completed_for_worker = Arc::clone(&task_completed);
    let tm_for_worker = tm.clone();
    let cancel_generation_at_start = tm.cancel_generation();
    let quick_cancel_generation_at_start =
        MEETING_QUICK_DICTATION_CANCEL_GENERATION.load(Ordering::Relaxed);
    let completion_context_for_watchdog = completion_context.clone();
    let tm_for_watchdog = tm.clone();
    let recording_duration = recording_duration.unwrap_or_default();
    let transcription_watchdog = samples
        .as_ref()
        .map(|samples| transcription_watchdog_delay(samples.len()))
        .unwrap_or(FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT + FULL_PASS_TRANSCRIPTION_WATCHDOG_GRACE);

    let transcription_task = tauri::async_runtime::spawn(async move {
        let mut finish_guard = Some(
            finish_guard
                .unwrap_or_else(|| FinishGuard::new(ah.clone(), binding_id.clone(), operation_id)),
        );
        let _completion_guard = CompletionGuard(task_completed_for_worker);
        let mut ui_guard = UiResetGuard::new(ah.clone(), completion_context.clone());
        let binding_id = binding_id.clone();
        debug!(
            "Starting async transcription task for binding: {}",
            binding_id
        );

        if dictation_output_was_cancelled(
            operation_id,
            &completion_context,
            quick_cancel_generation_at_start,
            &tm_for_worker,
            cancel_generation_at_start,
        ) {
            debug!("Transcription task was cancelled before processing started");
            restore_ui_after_transcription(&ah, &completion_context);
            return;
        }

        let Some(samples) = samples else {
            warn!("No samples retrieved from recording stop");
            if completion_mode == TranscriptionCompletionMode::EditMode {
                show_new_ask_selection_error_if_active(
                    &ah,
                    operation_id,
                    &context_snapshot,
                    "No audio captured. Try holding the shortcut a bit longer.".to_string(),
                );
                change_tray_icon(&ah, TrayIconState::Idle);
                return;
            }
            if recording_duration >= NO_INPUT_OVERLAY_MIN_DURATION {
                if complete_transcription_ui_if_active(completion_mode, operation_id, || {
                    restore_ui_or_show_no_input_feedback(&ah, &completion_context, post_process);
                }) {
                    ui_guard.suppress();
                }
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
            if completion_mode == TranscriptionCompletionMode::EditMode {
                show_new_ask_selection_error_if_active(
                    &ah,
                    operation_id,
                    &context_snapshot,
                    "No audio captured. Try holding the shortcut a bit longer.".to_string(),
                );
                change_tray_icon(&ah, TrayIconState::Idle);
                return;
            }
            if recording_duration >= NO_INPUT_OVERLAY_MIN_DURATION {
                if complete_transcription_ui_if_active(completion_mode, operation_id, || {
                    restore_ui_or_show_no_input_feedback(&ah, &completion_context, post_process);
                }) {
                    ui_guard.suppress();
                }
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
                publish_transcription_error_if_operation_active(operation_id, || {
                    let _ = ah.emit("transcription-error", message.to_string());
                });
                restore_ui_after_transcription(&ah, &completion_context);
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
        if completion_mode == TranscriptionCompletionMode::FullSystemOverlay {
            emit_session_window_state(
                &ah,
                session_window_state_payload(
                    FullSystemProgressStage::Transcribing,
                    None,
                    None,
                    None,
                ),
            );
        }

        if let Some(duration) = release_smoke_transcribing_hold_duration() {
            log::info!(
                "Release smoke holding transcribing state for {}ms",
                duration.as_millis()
            );
            tokio::time::sleep(duration).await;
        }

        if meeting_quick_dictation_was_cancelled(
            &completion_context,
            quick_cancel_generation_at_start,
        ) {
            debug!("Quick dictation was cancelled before transcription started");
            restore_ui_after_transcription(&ah, &completion_context);
            return;
        }

        let transcription_result = if use_incremental
            && samples.len() >= SHORT_UTTERANCE_SAMPLES
            && has_incremental_progress
        {
            debug!("Finishing incremental transcription with manager-bounded finalization");
            match tm_for_worker
                .finish_incremental_session(&binding_id, &samples)
                .await
            {
                Ok(text) => {
                    debug!(
                        "Incremental transcription finalized in {:?}",
                        transcription_time.elapsed()
                    );
                    Ok(text)
                }
                Err(incremental_err) => {
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
                if dictation_output_was_cancelled(
                    operation_id,
                    &completion_context,
                    quick_cancel_generation_at_start,
                    &tm_for_worker,
                    cancel_generation_at_start,
                ) {
                    debug!("Quick dictation was cancelled before output handling");
                    restore_ui_after_transcription(&ah, &completion_context);
                    return;
                }
                if suspected_no_input && transcription.trim().is_empty() {
                    if completion_mode == TranscriptionCompletionMode::EditMode {
                        show_new_ask_selection_error_if_active(
                            &ah,
                            operation_id,
                            &context_snapshot,
                            "No speech detected. Try recording again.".to_string(),
                        );
                        change_tray_icon(&ah, TrayIconState::Idle);
                        return;
                    }
                    refresh_microphone_stream_after_suspected_no_input(
                        &ah,
                        &binding_id,
                        completion_mode,
                    );
                    if complete_transcription_ui_if_active(completion_mode, operation_id, || {
                        restore_ui_or_show_no_input_feedback(
                            &ah,
                            &completion_context,
                            post_process,
                        );
                    }) {
                        ui_guard.suppress();
                    }
                    return;
                }
                debug!(
                    "{}",
                    format_transcription_completion_log(
                        transcription_time.elapsed(),
                        transcription.chars().count()
                    )
                );
                if !transcription.is_empty() {
                    let settings = get_settings(&ah);
                    if completion_mode == TranscriptionCompletionMode::EditMode {
                        let session_id = current_ask_selection_session_id();
                        let selected_text = context_snapshot
                            .selected_text
                            .as_deref()
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                            .map(ToOwned::to_owned)
                            .or_else(|| {
                                match crate::clipboard::capture_selected_text_via_copy(&ah) {
                                    Ok(Some(text)) => {
                                        log::info!(
                                            "Captured Ask Selection text via copy fallback (chars={})",
                                            text.chars().count()
                                        );
                                        context_snapshot.selected_text = Some(text.clone());
                                        Some(text)
                                    }
                                    Ok(None) => {
                                        debug!(
                                            "Ask Selection copy fallback did not find selected text"
                                        );
                                        None
                                    }
                                    Err(error) => {
                                        warn!("Ask Selection copy fallback unavailable: {}", error);
                                        None
                                    }
                                }
                            });

                        let mut thinking_messages = vec![
                            ask_selection_message("user", transcription.clone(), false),
                            ask_selection_message("assistant", "Thinking...", true),
                        ];
                        let thinking_payload = ask_selection_payload(
                            "thinking",
                            Some(session_id),
                            thinking_messages.clone(),
                            None,
                            None,
                        );
                        if !publish_new_ask_selection_session_if_active(
                            operation_id,
                            session_id,
                            Some(operation_id),
                            selected_text.clone(),
                            context_snapshot.clone(),
                            thinking_messages.clone(),
                            || utils::show_ask_selection_panel(&ah, thinking_payload),
                        ) {
                            change_tray_icon(&ah, TrayIconState::Idle);
                            return;
                        }
                        match answer_ask_selection(
                            &ah,
                            &settings,
                            selected_text.as_deref().unwrap_or(""),
                            &transcription,
                            &context_snapshot,
                        )
                        .await
                        {
                            Ok((answer_text, prompt_label)) => {
                                if dictation_output_was_cancelled(
                                    operation_id,
                                    &completion_context,
                                    quick_cancel_generation_at_start,
                                    &tm_for_worker,
                                    cancel_generation_at_start,
                                ) || !ask_selection_session_is_current(session_id)
                                {
                                    cancel_ask_selection_operation(&ah, operation_id);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                    return;
                                }

                                let is_cancelled = || {
                                    dictation_output_was_cancelled(
                                        operation_id,
                                        &completion_context,
                                        quick_cancel_generation_at_start,
                                        &tm_for_worker,
                                        cancel_generation_at_start,
                                    )
                                };
                                let mut persisted_entry_id = None;
                                let mut save_error = None;
                                match persist_with_cancellation_rollback(
                                    is_cancelled,
                                    || {
                                        hm.save_transcription(
                                            samples_clone,
                                            transcription.clone(),
                                            Some(answer_text.clone()),
                                            Some(prompt_label),
                                            "dictation",
                                        )
                                    },
                                    |entry_id| hm.rollback_dictation_entry(entry_id),
                                )
                                .await
                                {
                                    Ok(Some(entry_id)) => {
                                        persisted_entry_id = Some(entry_id);
                                    }
                                    Ok(None) => {
                                        debug!(
                                            "Rolled back Ask Selection history for cancelled dictation"
                                        );
                                        cancel_ask_selection_operation(&ah, operation_id);
                                        change_tray_icon(&ah, TrayIconState::Idle);
                                        return;
                                    }
                                    Err(e) => {
                                        error!("Failed to save Ask Selection transcription: {}", e);
                                        save_error = Some(e.to_string());
                                    }
                                }

                                thinking_messages.pop();
                                thinking_messages.push(ask_selection_message(
                                    "assistant",
                                    answer_text.clone(),
                                    false,
                                ));
                                let result_payload = ask_selection_payload(
                                    "result",
                                    Some(session_id),
                                    thinking_messages.clone(),
                                    Some(answer_text),
                                    None,
                                );
                                let save_error_message = save_error.map(|error| {
                                    format!(
                                        "Ask Selection succeeded, but saving history failed: {}",
                                        error
                                    )
                                });
                                if !complete_ask_selection_session_with_rollback(
                                    &hm,
                                    persisted_entry_id,
                                    operation_id,
                                    session_id,
                                    selected_text,
                                    context_snapshot,
                                    thinking_messages,
                                    || {
                                        utils::update_ask_selection_panel(&ah, result_payload);
                                        if let Some(error) = save_error_message {
                                            let _ = ah.emit("transcription-error", error);
                                        }
                                    },
                                ) {
                                    cancel_ask_selection_operation(&ah, operation_id);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                    return;
                                }
                                change_tray_icon(&ah, TrayIconState::Idle);
                            }
                            Err(error) => {
                                error!("Ask Selection failed: {}", error);
                                if dictation_output_was_cancelled(
                                    operation_id,
                                    &completion_context,
                                    quick_cancel_generation_at_start,
                                    &tm_for_worker,
                                    cancel_generation_at_start,
                                ) || !ask_selection_session_is_current(session_id)
                                {
                                    cancel_ask_selection_operation(&ah, operation_id);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                    return;
                                }

                                let error_messages = vec![ask_selection_message(
                                    "user",
                                    transcription.clone(),
                                    false,
                                )];
                                let error_payload = ask_selection_payload(
                                    "error",
                                    Some(session_id),
                                    error_messages.clone(),
                                    None,
                                    Some(error.clone()),
                                );
                                if !complete_ask_selection_session_if_active(
                                    operation_id,
                                    session_id,
                                    selected_text,
                                    context_snapshot,
                                    error_messages,
                                    || {
                                        utils::update_ask_selection_panel(&ah, error_payload);
                                        let _ = ah.emit("transcription-error", error);
                                    },
                                ) {
                                    cancel_ask_selection_operation(&ah, operation_id);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                    return;
                                }
                                change_tray_icon(&ah, TrayIconState::Idle);
                            }
                        }
                        return;
                    }

                    if post_process {
                        if completion_mode == TranscriptionCompletionMode::FullSystemOverlay {
                            emit_session_window_state(
                                &ah,
                                session_window_state_payload(
                                    FullSystemProgressStage::Processing,
                                    None,
                                    None,
                                    None,
                                ),
                            );
                        } else {
                            spawn_deferred_overlay_state(&ah, DeferredOverlayState::Processing);
                        }
                    }
                    let Some(finalized) = await_dictation_post_processing_if_active(
                        operation_id,
                        finalize_transcription_output(
                            &ah,
                            &settings,
                            &transcription,
                            post_process,
                            Some(&context_snapshot),
                        ),
                    )
                    .await
                    else {
                        debug!("Dictation was cancelled during post-processing");
                        restore_ui_after_transcription(&ah, &completion_context);
                        return;
                    };

                    if dictation_output_was_cancelled(
                        operation_id,
                        &completion_context,
                        quick_cancel_generation_at_start,
                        &tm_for_worker,
                        cancel_generation_at_start,
                    ) {
                        debug!("Dictation was cancelled after post-processing");
                        restore_ui_after_transcription(&ah, &completion_context);
                        return;
                    }
                    let final_text = finalized.final_text;
                    let post_processed_text = finalized.post_processed_text;
                    let post_process_prompt = finalized.post_process_prompt;

                    if completion_mode == TranscriptionCompletionMode::FullSystemOverlay {
                        match hm
                            .save_transcription(
                                samples_clone,
                                transcription.clone(),
                                post_processed_text,
                                post_process_prompt,
                                "full_system_audio",
                            )
                            .await
                        {
                            Ok(history_entry_id) => {
                                emit_session_window_state(
                                    &ah,
                                    session_window_state_payload(
                                        FullSystemProgressStage::Complete,
                                        None,
                                        Some(transcription.clone()),
                                        Some(history_entry_id),
                                    ),
                                );
                                change_tray_icon(&ah, TrayIconState::Idle);
                                ui_guard.suppress();
                                return;
                            }
                            Err(e) => {
                                error!("Failed to save transcription to history: {}", e);
                                let _ = ah.emit(
                                    "transcription-error",
                                    format!(
                                        "Transcription succeeded, but saving to history failed: {}",
                                        e
                                    ),
                                );
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                                return;
                            }
                        }
                    } else {
                        let is_cancelled = || {
                            dictation_output_was_cancelled(
                                operation_id,
                                &completion_context,
                                quick_cancel_generation_at_start,
                                &tm_for_worker,
                                cancel_generation_at_start,
                            )
                        };
                        let dictation_history_entry_id = match persist_with_cancellation_rollback(
                            is_cancelled,
                            || {
                                hm.save_transcription(
                                    samples_clone,
                                    transcription.clone(),
                                    post_processed_text,
                                    post_process_prompt,
                                    "dictation",
                                )
                            },
                            |entry_id| hm.rollback_dictation_entry(entry_id),
                        )
                        .await
                        {
                            Ok(entry_id) => entry_id,
                            Err(e) => {
                                error!("Failed to save transcription to history: {}", e);
                                None
                            }
                        };

                        if dictation_history_entry_id.is_none() && is_cancelled() {
                            restore_ui_after_transcription(&ah, &completion_context);
                            return;
                        }

                        if dictation_output_was_cancelled(
                            operation_id,
                            &completion_context,
                            quick_cancel_generation_at_start,
                            &tm_for_worker,
                            cancel_generation_at_start,
                        ) {
                            rollback_cancelled_dictation_history(&hm, dictation_history_entry_id);
                            restore_ui_after_transcription(&ah, &completion_context);
                            return;
                        }

                        let ah_clone = ah.clone();
                        let paste_completion_context = completion_context.clone();
                        let tm_for_paste = Arc::clone(&tm_for_worker);
                        let hm_for_paste = Arc::clone(&hm);
                        let hm_for_schedule_error = Arc::clone(&hm);
                        let paste_finish_guard = finish_guard.take();
                        let paste_time = Instant::now();
                        let schedule_result = ah.run_on_main_thread(move || {
                            let _finish_guard = paste_finish_guard;
                            if dictation_output_was_cancelled(
                                operation_id,
                                &paste_completion_context,
                                quick_cancel_generation_at_start,
                                &tm_for_paste,
                                cancel_generation_at_start,
                            ) {
                                debug!("Skipping paste for cancelled dictation");
                                rollback_cancelled_dictation_history(
                                    &hm_for_paste,
                                    dictation_history_entry_id,
                                );
                                restore_ui_after_transcription(
                                    &ah_clone,
                                    &paste_completion_context,
                                );
                                return;
                            }

                            if !complete_persisted_dictation_if_active(
                                &hm_for_paste,
                                dictation_history_entry_id,
                                operation_id,
                                || {
                                if let Some(history_entry_id) = dictation_history_entry_id {
                                    if release_smoke_enabled() {
                                        log::info!(
                                            "Release smoke history entry saved id={}",
                                            history_entry_id
                                        );
                                        let _ = ah_clone.emit(
                                            "show-history-entry",
                                            serde_json::json!({
                                                "entryId": history_entry_id,
                                            }),
                                        );
                                    }
                                }

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
                                restore_ui_after_transcription(
                                    &ah_clone,
                                    &paste_completion_context,
                                );
                                },
                            ) {
                                debug!("Cancellation won before dictation paste commit");
                                restore_ui_after_transcription(
                                    &ah_clone,
                                    &paste_completion_context,
                                );
                            }
                        });
                        if let Err(e) = schedule_result {
                            error!("Failed to run paste on main thread: {:?}", e);
                            rollback_cancelled_dictation_history(
                                &hm_for_schedule_error,
                                dictation_history_entry_id,
                            );
                            publish_transcription_error_if_operation_active(operation_id, || {
                                let _ = ah.emit(
                                    "transcription-error",
                                    "Transcription succeeded, but paste could not be scheduled."
                                        .to_string(),
                                );
                            });
                            restore_ui_after_transcription(&ah, &completion_context);
                        }
                        ui_guard.suppress();
                        return;
                    }
                } else if completion_mode == TranscriptionCompletionMode::EditMode {
                    if !show_new_ask_selection_error_if_active(
                        &ah,
                        operation_id,
                        &context_snapshot,
                        "No speech detected. Try recording again.".to_string(),
                    ) {
                        restore_ui_after_transcription(&ah, &completion_context);
                        return;
                    }
                    change_tray_icon(&ah, TrayIconState::Idle);
                } else {
                    complete_transcription_ui_if_active(completion_mode, operation_id, || {
                        restore_ui_after_transcription(&ah, &completion_context);
                    });
                }
            }
            Err(err) => {
                if dictation_output_was_cancelled(
                    operation_id,
                    &completion_context,
                    quick_cancel_generation_at_start,
                    &tm_for_worker,
                    cancel_generation_at_start,
                ) {
                    debug!("Suppressing transcription error for cancelled dictation");
                    cancel_ask_selection_operation(&ah, operation_id);
                    restore_ui_after_transcription(&ah, &completion_context);
                    return;
                }
                if completion_mode == TranscriptionCompletionMode::EditMode {
                    let message = if suspected_no_input {
                        "No speech detected. Try recording again.".to_string()
                    } else {
                        format!("Ask Selection transcription failed: {}", err)
                    };
                    if !show_new_ask_selection_error_if_active(
                        &ah,
                        operation_id,
                        &context_snapshot,
                        message,
                    ) {
                        restore_ui_after_transcription(&ah, &completion_context);
                        return;
                    }
                    change_tray_icon(&ah, TrayIconState::Idle);
                    return;
                }
                if suspected_no_input {
                    refresh_microphone_stream_after_suspected_no_input(
                        &ah,
                        &binding_id,
                        completion_mode,
                    );
                    if complete_transcription_ui_if_active(completion_mode, operation_id, || {
                        restore_ui_or_show_no_input_feedback(
                            &ah,
                            &completion_context,
                            post_process,
                        );
                    }) {
                        ui_guard.suppress();
                    }
                    return;
                }
                error!("Global Shortcut Transcription error: {}", err);
                publish_transcription_error_if_operation_active(operation_id, || {
                    let _ = ah.emit("transcription-error", err.to_string());
                });
                restore_ui_after_transcription(&ah, &completion_context);
            }
        }
    });

    {
        let app_for_watchdog = app.clone();
        let task_completed = Arc::clone(&task_completed);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(transcription_watchdog).await;
            if task_completed.load(Ordering::Relaxed) {
                return;
            }

            if dictation_output_was_cancelled(
                operation_id,
                &completion_context_for_watchdog,
                quick_cancel_generation_at_start,
                &tm_for_watchdog,
                cancel_generation_at_start,
            ) {
                debug!("Suppressing watchdog error for cancelled dictation");
                transcription_task.abort();
                return;
            }

            warn!(
                "Transcription watchdog fired after {}s; aborting only this transcription task",
                transcription_watchdog.as_secs()
            );
            transcription_task.abort();
            publish_transcription_error_if_operation_active(operation_id, || {
                let _ = app_for_watchdog.emit(
                    "transcription-error",
                    "Transcription timed out. Please try again.".to_string(),
                );
            });
        });
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        utils::cancel_pending_overlay_transitions();

        let access = get_install_access_snapshot(app);
        if !install_access_allows_transcription(&access) {
            change_tray_icon(app, TrayIconState::Idle);
            utils::show_trial_ended_overlay(app);
            let overlay_epoch = utils::current_overlay_session_epoch();
            utils::emit_overlay_alert(app, "trial_ended");
            let ah = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(120));
                if utils::current_overlay_session_epoch() != overlay_epoch {
                    return;
                }
                utils::emit_overlay_alert(&ah, "trial_ended");
                std::thread::sleep(std::time::Duration::from_secs(5));
                if utils::current_overlay_session_epoch() == overlay_epoch {
                    utils::hide_recording_overlay(&ah);
                }
            });
            return;
        }

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.clear_cancel_request();
        let settings = get_settings(app);
        if self.completion_mode == TranscriptionCompletionMode::EditMode
            && !settings.edit_mode_enabled
        {
            let message = "Ask Selection is disabled in settings.";
            warn!("{}", message);
            let _ = app.emit("transcription-error", message.to_string());
            change_tray_icon(app, TrayIconState::Idle);
            utils::hide_recording_overlay(app);
            return;
        }
        let is_edit_mode = self.completion_mode == TranscriptionCompletionMode::EditMode;
        if is_edit_mode {
            clear_ask_selection_session();
            utils::hide_ask_selection_panel(app);
        }
        if !is_edit_mode && (self.post_process || settings.post_process_enabled) {
            store_active_context_async(&binding_id);
        }
        let use_incremental = should_use_incremental_transcription(&settings, &tm);

        let binding_id = binding_id.to_string();
        let rm = app.state::<Arc<AudioRecordingManager>>();
        let meeting_microphone_binding =
            meeting_microphone_binding_for_quick_dictation(app, &binding_id);

        // Get the microphone mode to determine audio feedback timing
        let is_always_on = settings.always_on_microphone;
        let should_show_warming = !is_always_on && !rm.is_microphone_open();
        debug!("Microphone mode - always_on: {}", is_always_on);

        change_tray_icon(app, TrayIconState::Recording);

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

            recording_started =
                if let Some(meeting_binding_id) = meeting_microphone_binding.as_deref() {
                    borrow_meeting_microphone_for_quick_dictation(
                        app,
                        &rm,
                        meeting_binding_id,
                        &binding_id,
                    )
                } else {
                    rm.try_start_recording(&binding_id)
                };
            debug!("Recording started: {}", recording_started);
            log::info!(
                "[latency] transcribe recording active binding={} recording_started={} elapsed_ms={}",
                binding_id,
                recording_started,
                start_time.elapsed().as_millis()
            );
            if recording_started {
                show_recording_overlay(app);
                log::info!(
                    "[latency] transcribe overlay requested binding={} warming=false elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
            }
        } else {
            // On-demand mode: Start recording first, then play audio feedback, then apply mute
            // This allows the microphone to be activated before playing the sound
            debug!("On-demand mode: Starting recording first, then audio feedback");
            if should_show_warming {
                show_warming_overlay(app);
                log::info!(
                    "[latency] transcribe overlay requested binding={} warming=true elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
            }
            let recording_start_time = Instant::now();
            let borrow_or_start_succeeded =
                if let Some(meeting_binding_id) = meeting_microphone_binding.as_deref() {
                    borrow_meeting_microphone_for_quick_dictation(
                        app,
                        &rm,
                        meeting_binding_id,
                        &binding_id,
                    )
                } else {
                    rm.try_start_recording(&binding_id)
                };
            if borrow_or_start_succeeded {
                recording_started = true;
                show_recording_overlay(app);
                log::info!(
                    "[latency] transcribe overlay requested binding={} warming=false elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
                log::info!(
                    "[latency] transcribe recording active binding={} elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
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

        if is_edit_mode && recording_started {
            let context_start = Instant::now();
            let snapshot = capture_ask_selection_start_context();
            store_active_context_snapshot(&binding_id, snapshot);
            log::info!(
                "[latency] ask selection context captured after recording overlay binding={} elapsed_ms={} total_start_elapsed_ms={}",
                binding_id,
                context_start.elapsed().as_millis(),
                start_time.elapsed().as_millis()
            );
        }

        if is_edit_mode && !recording_started {
            let session_id = current_ask_selection_session_id();
            utils::show_ask_selection_panel(
                app,
                ask_selection_payload(
                    "error",
                    Some(session_id),
                    Vec::new(),
                    None,
                    Some("Ask Selection could not start recording.".to_string()),
                ),
            );
        }

        tm.cancel_incremental_session();
        start_transcription_session(app, &binding_id, recording_started);
        let preload_model_id = if settings.selected_model.is_empty() {
            tm.get_current_model().unwrap_or_default()
        } else {
            settings.selected_model.clone()
        };
        // Keep visual recording feedback on the hot path. Local model preload
        // is useful, but it can wait until after the overlay has been requested.
        if preload_model_id.is_empty() || !is_cloud_model_id(&preload_model_id) {
            tm.initiate_model_load();
        } else {
            debug!(
                "Skipping preload for cloud model '{}' in hot path",
                preload_model_id
            );
        }
        if recording_started && use_incremental {
            if let Err(e) = tm.start_incremental_session(&binding_id, Arc::clone(&rm)) {
                warn!("Failed to start incremental transcription session: {}", e);
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
        log::info!(
            "[latency] transcribe action start end binding={} recording_started={} elapsed_ms={}",
            binding_id,
            recording_started,
            start_time.elapsed().as_millis()
        );
    }

    fn stop(
        &self,
        app: &AppHandle,
        binding_id: &str,
        _shortcut_str: &str,
        operation_id: OperationId,
    ) {
        let stop_time = Instant::now();
        log::info!(
            "[latency] transcribe action stop begin binding={}",
            binding_id
        );
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let settings = get_settings(app);
        // When post-processing is enabled in settings, apply it automatically for normal
        // transcription. The dedicated post-process hotkey still forces it on.
        let post_process = self.post_process || settings.post_process_enabled;
        let use_incremental = should_use_incremental_transcription(&settings, &tm);
        let is_edit_mode = self.completion_mode == TranscriptionCompletionMode::EditMode;
        warn!(
            "[ask-hotkey] action_stop binding={} completion_mode={} is_edit_mode={}",
            binding_id,
            match self.completion_mode {
                TranscriptionCompletionMode::Standard => "standard",
                TranscriptionCompletionMode::EditMode => "edit_mode",
                TranscriptionCompletionMode::FullSystemOverlay => "full_system_overlay",
            },
            is_edit_mode
        );
        change_tray_icon(app, TrayIconState::Transcribing);
        if is_edit_mode {
            show_transcribing_overlay(app);
        } else {
            spawn_deferred_overlay_state(app, DeferredOverlayState::Transcribing);
        }
        if use_incremental {
            tm.signal_incremental_stop(binding_id);
        }
        let recording_duration = rm.current_recording_duration(binding_id);
        let active_meeting_binding = active_meeting_binding_for_quick_dictation(app, binding_id);
        let meeting_restore_binding =
            meeting_microphone_binding_for_quick_dictation(app, binding_id);
        let samples = if let Some(meeting_binding_id) = meeting_restore_binding.as_deref() {
            rm.finish_borrowed_recording_and_restore(binding_id, meeting_binding_id)
        } else {
            rm.stop_recording(binding_id)
        };
        let completion_context =
            completion_context_for_active_meeting(active_meeting_binding, operation_id);
        log::info!(
            "[latency] transcribe samples retrieved binding={} sample_count={} elapsed_ms={}",
            binding_id,
            samples.as_ref().map(|samples| samples.len()).unwrap_or(0),
            stop_time.elapsed().as_millis()
        );
        handle_transcription_stop(
            app,
            binding_id,
            operation_id,
            samples,
            recording_duration,
            post_process,
            use_incremental,
            self.completion_mode,
            completion_context,
            tm,
            hm,
            None,
        );
        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
        log::info!(
            "[latency] transcribe action stop end binding={} elapsed_ms={}",
            binding_id,
            stop_time.elapsed().as_millis()
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
        let binding_id = binding_id.to_string();
        let full_system_audio = app.state::<Arc<FullSystemAudioSessionManager>>();
        let live_session_status = full_system_live_session_status(&binding_id);
        let active_session = full_system_audio.active_snapshot();
        if let Some(existing_decision) = existing_full_system_live_start_decision(
            &binding_id,
            active_session.as_ref(),
            live_session_status,
        ) {
            if existing_decision.recording_started {
                if live_session_status == FullSystemLiveSessionStatus::Finalizing {
                    // A coordinator panic can leave capture active after Stop has
                    // signaled the worker. Re-expose the active session so the
                    // recovered coordinator can dispatch Stop again; the next
                    // drain still feeds the retained runtime during finalization.
                    change_tray_icon(app, TrayIconState::Recording);
                    emit_active_session_window_state(app);
                }
                debug!(
                    "Full-system recording already active for '{}' with {:?} live runtime; reusing capture without duplicate start side effects",
                    binding_id, live_session_status
                );
            } else {
                debug!(
                    "Ignoring full-system start for '{}' while its {:?} live runtime is awaiting finalization",
                    binding_id, live_session_status
                );
            }
            log::info!(
                "[latency] full-system action repeated start end binding={} recording_started={} live_runtime={:?} elapsed_ms={}",
                binding_id,
                existing_decision.recording_started,
                live_session_status,
                start_time.elapsed().as_millis()
            );
            return;
        }

        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.clear_cancel_request();
        let settings = get_settings(app);
        tm.cancel_incremental_session();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        let is_always_on = settings.always_on_microphone;
        debug!("Full-system mode - always_on: {}", is_always_on);

        let start_config = crate::full_system_audio_bridge::FullSystemAudioCaptureConfig::default();
        let recording_start_time = Instant::now();
        let start_result = full_system_audio.start_session(&binding_id, start_config);
        let start_decision = full_system_live_start_decision(&binding_id, &start_result);
        let recording_started = start_decision.recording_started;

        if start_decision.initialize_live_runtime {
            start_full_system_live_session(app, &binding_id);
        }

        if start_decision.perform_start_side_effects {
            change_tray_icon(app, TrayIconState::Recording);
            focus_workspace_window(app);
            emit_active_session_window_state(app);
            start_transcription_session(app, binding_id.as_str(), true);

            let app_clone = app.clone();
            let rm_clone = Arc::clone(&rm);
            std::thread::spawn(move || {
                if !is_always_on {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    debug!("Handling delayed full-system audio feedback/mute sequence");
                }
                play_feedback_sound_blocking(&app_clone, SoundType::Start);
                rm_clone.apply_mute();
            });

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

            log::info!(
                "[latency] full-system session UI active binding={} elapsed_ms={}",
                binding_id,
                start_time.elapsed().as_millis()
            );
        } else if recording_started {
            debug!(
                "Recovered missing full-system live runtime for active recording '{}' without duplicate start side effects",
                binding_id
            );
        } else {
            debug!("Failed to start full-system recording");
            start_transcription_session(app, binding_id.as_str(), false);
            emit_idle_session_window_state(app);
        }

        log::info!(
            "[latency] full-system recording active binding={} recording_started={} new_session_started={} elapsed_ms={}",
            binding_id,
            recording_started,
            start_result.new_session_started,
            start_time.elapsed().as_millis()
        );
        debug!(
            "Full-system recording start decision completed in {:?}",
            recording_start_time.elapsed()
        );

        debug!(
            "FullSystemTranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
        log::info!(
            "[latency] full-system action start end binding={} recording_started={} elapsed_ms={}",
            binding_id,
            recording_started,
            start_time.elapsed().as_millis()
        );
    }

    fn stop(
        &self,
        app: &AppHandle,
        binding_id: &str,
        _shortcut_str: &str,
        operation_id: OperationId,
    ) {
        let stop_time = Instant::now();
        log::info!(
            "[latency] full-system action stop begin binding={}",
            binding_id
        );
        debug!(
            "FullSystemTranscribeAction::stop called for binding: {}",
            binding_id
        );

        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());
        let full_system_audio = app.state::<Arc<FullSystemAudioSessionManager>>();
        let post_process = self.post_process || get_settings(app).post_process_enabled;
        let finish_guard =
            FinishGuard::new_full_system(app.clone(), binding_id.to_string(), operation_id);

        change_tray_icon(app, TrayIconState::Transcribing);
        utils::hide_recording_overlay(app);
        emit_session_window_state(
            app,
            session_window_state_payload(FullSystemProgressStage::Preparing, None, None, None),
        );
        rm.remove_mute();
        play_feedback_sound(app, SoundType::Stop);

        signal_full_system_live_session_stop(binding_id);
        if let Some(delta) = full_system_audio.drain_session_delta_sources(binding_id) {
            append_full_system_live_session_delta(binding_id, delta);
        }
        let stop_result: FullSystemSessionStopResult = full_system_audio.stop_session();
        log::info!(
            "[latency] full-system samples retrieved binding={} sample_count={} elapsed_ms={}",
            binding_id,
            stop_result
                .transcription_samples
                .as_ref()
                .map(|samples| samples.len())
                .unwrap_or(0),
            stop_time.elapsed().as_millis()
        );

        let fallback_samples = stop_result.transcription_samples.clone();
        let live_tail_samples =
            if fallback_samples.is_some() || !stop_result.transcription_source_samples.is_empty() {
                Some(FullSystemSessionTranscriptionSamples {
                    mixed: stop_result.transcription_samples,
                    sources: stop_result.transcription_source_samples,
                })
            } else {
                None
            };
        let live_app = app.clone();
        let live_binding_id = binding_id.to_string();
        let live_tm = Arc::clone(&tm);
        let live_hm = Arc::clone(&hm);
        tauri::async_runtime::spawn(async move {
            let mut completion_owner = CompletionOwner::new(finish_guard);
            let mut ui_guard =
                UiResetGuard::new(live_app.clone(), TranscriptionCompletionContext::Standalone);
            if let Some(live_final) = finish_full_system_live_session(
                &live_app,
                &live_binding_id,
                live_tail_samples,
                Arc::clone(&live_tm),
            )
            .await
            {
                if !should_persist_full_system_live_final(&live_final) {
                    debug!("Live full-system session stopped without transcript text");
                    emit_session_window_state(
                        &live_app,
                        session_window_state_payload(
                            FullSystemProgressStage::Complete,
                            Some("No transcript was captured for this session.".to_string()),
                            None,
                            None,
                        ),
                    );
                    change_tray_icon(&live_app, TrayIconState::Idle);
                    ui_guard.suppress();
                    return;
                }

                if live_final.transcript_text.trim().is_empty() {
                    let failure_kind = if live_final.final_transcription_timed_out {
                        "final transcription timeout"
                    } else {
                        "transcription failure"
                    };
                    warn!(
                        "Saving full-system session audio without transcript after {}",
                        failure_kind
                    );
                }

                match persist_full_system_live_final(&live_hm, &live_final).await {
                    Ok(history_entry_id) => {
                        emit_session_window_state(
                            &live_app,
                            session_window_state_payload(
                                FullSystemProgressStage::Complete,
                                live_final.summary_text.clone(),
                                Some(live_final.transcript_text.clone()),
                                Some(history_entry_id),
                            ),
                        );
                    }
                    Err(error) => {
                        warn!("Failed to save live full-system session: {}", error);
                        emit_session_window_state(
                            &live_app,
                            session_window_state_payload(
                                FullSystemProgressStage::Complete,
                                Some(format!("Session could not be saved: {}", error)),
                                Some(live_final.transcript_text.clone()),
                                None,
                            ),
                        );
                    }
                }
                change_tray_icon(&live_app, TrayIconState::Idle);
                ui_guard.suppress();
                return;
            }

            drop(ui_guard);
            handle_transcription_stop(
                &live_app,
                &live_binding_id,
                operation_id,
                fallback_samples,
                None,
                post_process,
                false,
                TranscriptionCompletionMode::FullSystemOverlay,
                TranscriptionCompletionContext::Standalone,
                live_tm,
                live_hm,
                Some(completion_owner.transfer()),
            );
        });

        debug!(
            "FullSystemTranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
        log::info!(
            "[latency] full-system action stop end binding={} elapsed_ms={}",
            binding_id,
            stop_time.elapsed().as_millis()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
            coordinator.request_user_cancel();
        }
    }

    fn stop(
        &self,
        _app: &AppHandle,
        _binding_id: &str,
        _shortcut_str: &str,
        _operation_id: OperationId,
    ) {
        // Nothing to do on stop for cancel
    }
}

// Copy Last Transcript Action
struct CopyLastTranscriptAction;

impl ShortcutAction for CopyLastTranscriptAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        crate::tray::copy_last_transcript(app);
    }

    fn stop(
        &self,
        _app: &AppHandle,
        _binding_id: &str,
        _shortcut_str: &str,
        _operation_id: OperationId,
    ) {
        // Nothing to do on stop for one-shot actions.
    }
}

impl ShortcutAction for TogglePostProcessingAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        let mut settings = get_settings(app);
        let enabled = toggle_post_process_enabled(&mut settings);
        write_settings(app, settings);

        let _ = app.emit(
            "settings-changed",
            serde_json::json!({
                "setting": "post_process_enabled",
                "value": enabled
            }),
        );

        log::info!("Post-processing toggled via shortcut: enabled={}", enabled);
    }

    fn stop(
        &self,
        _app: &AppHandle,
        _binding_id: &str,
        _shortcut_str: &str,
        _operation_id: OperationId,
    ) {
        // Toggle shortcuts act on press only.
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

    fn stop(
        &self,
        app: &AppHandle,
        binding_id: &str,
        shortcut_str: &str,
        _operation_id: OperationId,
    ) {
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
            completion_mode: TranscriptionCompletionMode::Standard,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TogglePostProcessingAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_full_system_audio".to_string(),
        Arc::new(FullSystemTranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "edit_mode".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
            completion_mode: TranscriptionCompletionMode::EditMode,
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
        append_full_system_live_audio_delta, append_full_system_stop_tail_samples,
        append_live_transcription_segments, ask_selection_message, ask_selection_payload,
        ask_selection_session_is_current, await_dictation_post_processing_if_active,
        await_full_system_live_transcription_task, await_full_system_live_worker_stop,
        build_ask_selection_follow_up_prompt, build_ask_selection_prompt,
        build_live_summary_prompt, cancel_ask_selection_session_if_owned,
        cancel_dictation_operation, clean_ask_selection_response, clean_post_process_response,
        clear_ask_selection_session, commit_full_system_live_transcription_segments,
        complete_ask_selection_session_with_rollback, complete_dictation_operation_if_active,
        complete_persisted_dictation_if_active, complete_transcription_ui_if_active,
        completion_context_for_active_meeting, current_ask_selection_messages,
        current_ask_selection_session_id, custom_vocabulary_prompt_block,
        existing_full_system_live_start_decision, format_labeled_transcript_segments,
        format_transcription_completion_log, friendly_live_summary_error,
        full_system_live_chunk_transcription_timeout, full_system_live_final_chunk_timeout,
        full_system_live_session_status, full_system_live_start_decision,
        is_effectively_silent_audio, is_effectively_silent_full_system_source_audio,
        is_supported_post_process_model, mark_full_system_live_transcription_failure,
        normalize_live_summary_output, parse_meeting_summary_state, persist_full_system_live_final,
        persist_with_cancellation_rollback, publish_new_ask_selection_session_if_active,
        publish_transcription_error_if_operation_active, quick_dictation_ui_restore_is_current,
        reap_full_system_live_transcription_task, record_full_system_live_chunk_samples,
        record_full_system_live_finalization_audio, release_dictation_operation,
        render_meeting_summary_markdown, resolved_post_process_system_prompt,
        select_preferred_groq_model, should_pause_live_summaries,
        should_persist_full_system_live_final,
        should_refresh_microphone_stream_after_suspected_no_input, should_register_cancel_shortcut,
        should_restore_meeting_ui, should_suppress_quick_dictation_output,
        should_update_live_summary, snapshot_full_system_live_runtime,
        take_full_system_live_finalization_chunks, take_next_full_system_live_chunk,
        toggle_post_process_enabled, transcribe_full_system_live_chunk_sources_with,
        transcription_timeout_for_samples, transcription_watchdog_delay,
        update_ask_selection_session, usable_post_processed_text, CompletionOwner,
        FullSystemFinalizationBarrier, FullSystemLiveChunk, FullSystemLiveInFlightChunk,
        FullSystemLiveRuntime, FullSystemLiveSessionStatus, FullSystemLiveTranscriptionTask,
        LabeledTranscriptSegment, MeetingSummaryState, SummaryPoint,
        TranscriptionCompletionContext, TranscriptionCompletionMode, ACTION_MAP,
        ACTIVE_QUICK_DICTATION_UI_OPERATION, FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT,
        FULL_SYSTEM_LIVE_CHUNK_SAMPLES, FULL_SYSTEM_LIVE_CHUNK_SECONDS,
        FULL_SYSTEM_LIVE_FINAL_CHUNK_EXTRA_TIMEOUT, FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL,
    };
    use crate::app_context::AppContextSnapshot;
    use crate::managers::full_system_audio::{
        FullSystemSessionSnapshot, FullSystemSessionStartResult,
        FullSystemSessionTranscriptionSamples, FullSystemSourceOutcome,
        FullSystemTranscriptionSource, FullSystemTranscriptionSourceSamples,
    };
    use crate::managers::history::HistoryManager;
    use crate::settings::get_default_settings;
    use crate::transcription_coordinator::MeetingControlTestDriver;
    use once_cell::sync::Lazy;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };

    static ASK_SELECTION_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn completed_live_transcription_task(
        segments: Vec<LabeledTranscriptSegment>,
    ) -> FullSystemLiveTranscriptionTask {
        Arc::new(tokio::sync::Mutex::new(tauri::async_runtime::spawn(
            async move { Ok(segments) },
        )))
    }

    fn two_source_live_chunk() -> FullSystemLiveChunk {
        let samples = vec![0.1; 16_000];
        FullSystemLiveChunk {
            mixed_samples: samples.clone(),
            source_samples: vec![
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: samples.clone(),
                },
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples,
                },
            ],
        }
    }

    #[test]
    fn supported_shortcut_bindings_are_registered_in_action_map() {
        for binding_id in [
            "transcribe_full_system_audio",
            "copy_last_transcript",
            "transcribe_with_post_process",
            "edit_mode",
        ] {
            assert!(ACTION_MAP.contains_key(binding_id), "binding: {binding_id}");
        }
    }

    #[test]
    fn transcription_completion_log_excludes_spoken_content() {
        let sentinel = "private spoken instruction sk-test /Users/alice/private.wav";
        let message = format_transcription_completion_log(
            std::time::Duration::from_millis(1_250),
            sentinel.chars().count(),
        );

        assert!(message.contains("Transcription completed"));
        assert!(message.contains(&format!("chars={}", sentinel.chars().count())));
        assert!(!message.contains(sentinel));
        assert!(!message.contains("sk-test"));
        assert!(!message.contains("/Users/alice"));
    }

    fn active_full_system_start_result(new_session_started: bool) -> FullSystemSessionStartResult {
        FullSystemSessionStartResult {
            session: Some(FullSystemSessionSnapshot {
                session_id: 1,
                binding_id: "transcribe_full_system_audio".to_string(),
                system_audio: FullSystemSourceOutcome::default(),
                microphone: FullSystemSourceOutcome::default(),
                degraded: false,
            }),
            started: true,
            new_session_started,
            bridge_result: None,
            system_audio_error: None,
            microphone_error: None,
        }
    }

    #[test]
    fn repeated_full_system_start_preserves_running_or_finalizing_live_runtime() {
        let repeated = active_full_system_start_result(false);
        let active_session = repeated.session.as_ref();
        let decision = existing_full_system_live_start_decision(
            "transcribe_full_system_audio",
            active_session,
            FullSystemLiveSessionStatus::Running,
        )
        .expect("existing running runtime decision");

        assert!(decision.recording_started);
        assert!(!decision.initialize_live_runtime);
        assert!(!decision.perform_start_side_effects);

        let finalizing_active = existing_full_system_live_start_decision(
            "transcribe_full_system_audio",
            active_session,
            FullSystemLiveSessionStatus::Finalizing,
        )
        .expect("existing finalizing runtime decision");
        assert!(finalizing_active.recording_started);
        assert!(!finalizing_active.initialize_live_runtime);
        assert!(!finalizing_active.perform_start_side_effects);

        let finalizing_idle = existing_full_system_live_start_decision(
            "transcribe_full_system_audio",
            None,
            FullSystemLiveSessionStatus::Finalizing,
        )
        .expect("finalization barrier decision");
        assert!(!finalizing_idle.recording_started);
        assert!(!finalizing_idle.initialize_live_runtime);
        assert!(!finalizing_idle.perform_start_side_effects);

        assert!(existing_full_system_live_start_decision(
            "transcribe_full_system_audio",
            active_session,
            FullSystemLiveSessionStatus::Missing,
        )
        .is_none());

        let missing_runtime =
            full_system_live_start_decision("transcribe_full_system_audio", &repeated);
        assert!(missing_runtime.recording_started);
        assert!(missing_runtime.initialize_live_runtime);
        assert!(!missing_runtime.perform_start_side_effects);

        let first_start = full_system_live_start_decision(
            "transcribe_full_system_audio",
            &active_full_system_start_result(true),
        );
        assert!(first_start.recording_started);
        assert!(first_start.initialize_live_runtime);
        assert!(first_start.perform_start_side_effects);
    }

    #[test]
    fn full_system_finalization_barrier_remains_visible_after_runtime_is_taken() {
        let binding_id = "test-full-system-finalization-barrier";
        assert_eq!(
            full_system_live_session_status(binding_id),
            FullSystemLiveSessionStatus::Missing
        );

        let barrier = FullSystemFinalizationBarrier::new(binding_id.to_string(), u64::MAX - 9);
        let duplicate_barrier =
            FullSystemFinalizationBarrier::new(binding_id.to_string(), u64::MAX - 9);
        assert_eq!(
            full_system_live_session_status(binding_id),
            FullSystemLiveSessionStatus::Finalizing
        );

        drop(barrier);
        assert_eq!(
            full_system_live_session_status(binding_id),
            FullSystemLiveSessionStatus::Finalizing
        );
        drop(duplicate_barrier);
        assert_eq!(
            full_system_live_session_status(binding_id),
            FullSystemLiveSessionStatus::Missing
        );
    }

    #[test]
    fn meetings_do_not_register_escape_but_dictation_does() {
        assert!(!should_register_cancel_shortcut(
            "transcribe_full_system_audio",
            true
        ));
        assert!(should_register_cancel_shortcut("transcribe", true));
        assert!(!should_register_cancel_shortcut("transcribe", false));
    }

    #[test]
    fn cancelled_nested_dictation_suppresses_only_its_output() {
        assert!(should_suppress_quick_dictation_output(true, 4, 5));
        assert!(!should_suppress_quick_dictation_output(true, 5, 5));
        assert!(!should_suppress_quick_dictation_output(false, 4, 5));
    }

    #[tokio::test]
    async fn cancellation_during_blocked_post_processing_discards_dictation_output() {
        let operation_id = u64::MAX - 1;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let post_processing = async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
            "processed"
        };
        let task = tokio::spawn(await_dictation_post_processing_if_active(
            operation_id,
            post_processing,
        ));

        let _ = started_rx.await;
        cancel_dictation_operation(operation_id);
        let _ = release_tx.send(());

        assert_eq!(task.await.unwrap(), None);
    }

    #[tokio::test]
    async fn cancellation_during_blocked_persistence_rolls_back_history_and_wav() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let history_exists = Arc::new(AtomicBool::new(false));
        let wav_exists = Arc::new(AtomicBool::new(false));
        let pasted = Arc::new(AtomicBool::new(false));
        let completion_ui = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let task_cancelled = Arc::clone(&cancelled);
        let save_history = Arc::clone(&history_exists);
        let save_wav = Arc::clone(&wav_exists);
        let rollback_history = Arc::clone(&history_exists);
        let rollback_wav = Arc::clone(&wav_exists);
        let task_pasted = Arc::clone(&pasted);
        let task_completion_ui = Arc::clone(&completion_ui);
        let task = tokio::spawn(async move {
            let result = persist_with_cancellation_rollback(
                || task_cancelled.load(Ordering::Acquire),
                || async move {
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    save_history.store(true, Ordering::Release);
                    save_wav.store(true, Ordering::Release);
                    Ok::<i64, &'static str>(41)
                },
                move |_entry_id| {
                    rollback_history.store(false, Ordering::Release);
                    rollback_wav.store(false, Ordering::Release);
                    Ok::<(), &'static str>(())
                },
            )
            .await?;
            if result.is_some() {
                task_pasted.store(true, Ordering::Release);
                task_completion_ui.store(true, Ordering::Release);
            }
            Ok::<Option<i64>, &'static str>(result)
        });

        let _ = started_rx.await;
        cancelled.store(true, Ordering::Release);
        let _ = release_tx.send(());

        assert_eq!(task.await.unwrap().unwrap(), None);
        assert!(!history_exists.load(Ordering::Acquire));
        assert!(!wav_exists.load(Ordering::Acquire));
        assert!(!pasted.load(Ordering::Acquire));
        assert!(!completion_ui.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn ask_selection_cancellation_racing_real_persistence_rolls_back_exact_artifacts() {
        let root = tempfile::tempdir().expect("create history root");
        let history_manager = Arc::new(
            HistoryManager::new_for_test(root.path()).expect("create test history manager"),
        );
        let operation_id = u64::MAX - 20;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let history_for_save = Arc::clone(&history_manager);
        let history_for_rollback = Arc::clone(&history_manager);

        let save_task = tokio::spawn(async move {
            persist_with_cancellation_rollback(
                || super::dictation_operation_was_cancelled(operation_id),
                || async move {
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    history_for_save
                        .save_transcription(
                            vec![0.05; 1_600],
                            "What does this selection mean?".to_string(),
                            Some("It explains the selected text.".to_string()),
                            Some("Ask Selection".to_string()),
                            "dictation",
                        )
                        .await
                },
                move |entry_id| history_for_rollback.rollback_dictation_entry(entry_id),
            )
            .await
        });

        let _ = started_rx.await;
        cancel_dictation_operation(operation_id);
        let _ = release_tx.send(());

        assert_eq!(save_task.await.unwrap().unwrap(), None);
        assert!(history_manager
            .get_history_entries()
            .await
            .expect("query cancelled Ask Selection history")
            .is_empty());
        assert_eq!(
            std::fs::read_dir(root.path().join("recordings"))
                .expect("read recordings")
                .count(),
            0
        );

        let successful_id = history_manager
            .save_transcription(
                vec![0.05; 1_600],
                "What does this selection mean?".to_string(),
                Some("It explains the selected text.".to_string()),
                Some("Ask Selection".to_string()),
                "dictation",
            )
            .await
            .expect("save successful Ask Selection history");
        let successful = history_manager
            .get_entry_by_id(successful_id)
            .await
            .expect("query successful Ask Selection")
            .expect("successful Ask Selection entry exists");
        assert_eq!(successful.recording_source, "dictation");
        assert_eq!(
            successful.post_processed_text.as_deref(),
            Some("It explains the selected text.")
        );
        assert_eq!(
            successful.post_process_prompt.as_deref(),
            Some("Ask Selection")
        );
        assert!(history_manager
            .get_audio_file_path(&successful.file_name)
            .exists());
    }

    #[tokio::test]
    async fn production_control_commands_cancel_nested_dictation_and_save_later_meeting_chunk() {
        let root = tempfile::tempdir().expect("create history root");
        let history_manager = Arc::new(
            HistoryManager::new_for_test(root.path()).expect("create test history manager"),
        );
        let runtime = FullSystemLiveRuntime::new();
        append_live_transcription_segments(
            &runtime,
            &[LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "meeting before quick dictation".to_string(),
            }],
        );
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend(vec![0.05; 1_600]);

        let meeting_id = u64::MAX - 18;
        let quick_id = u64::MAX - 17;
        let mut coordinator = MeetingControlTestDriver::with_processing_quick(meeting_id, quick_id);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let history_for_save = Arc::clone(&history_manager);
        let history_for_rollback = Arc::clone(&history_manager);
        let pasted = Arc::new(AtomicBool::new(false));
        let pasted_after_save = Arc::clone(&pasted);
        let quick_save = tokio::spawn(async move {
            let persisted = persist_with_cancellation_rollback(
                || super::dictation_operation_was_cancelled(quick_id),
                || async move {
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    history_for_save
                        .save_transcription(
                            vec![0.05; 800],
                            "cancel this nested dictation".to_string(),
                            None,
                            None,
                            "dictation",
                        )
                        .await
                },
                move |entry_id| history_for_rollback.rollback_dictation_entry(entry_id),
            )
            .await?;
            if persisted.is_some() {
                pasted_after_save.store(true, Ordering::Release);
            }
            Ok::<Option<i64>, anyhow::Error>(persisted)
        });

        let _ = started_rx.await;
        let cancelled_quick_id = coordinator.request_user_cancel();
        assert_eq!(cancelled_quick_id, quick_id);
        cancel_dictation_operation(cancelled_quick_id);
        let _ = release_tx.send(());

        assert_eq!(quick_save.await.unwrap().unwrap(), None);
        assert!(!pasted.load(Ordering::Acquire));
        assert!(history_manager
            .get_history_entries()
            .await
            .expect("query cancelled quick history")
            .is_empty());
        coordinator.notify_stale_quick_finished(quick_id);

        append_live_transcription_segments(
            &runtime,
            &[LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "meeting chunk captured after nested cancellation".to_string(),
            }],
        );
        let stopped_meeting_id = coordinator.request_meeting_stop();
        assert_eq!(stopped_meeting_id, meeting_id);
        coordinator.assert_duplicate_stop_is_ignored();
        let live_final = snapshot_full_system_live_runtime(&runtime).expect("snapshot meeting");
        let meeting_history_id = persist_full_system_live_final(&history_manager, &live_final)
            .await
            .expect("persist stopped meeting");
        coordinator.notify_meeting_finished(stopped_meeting_id);

        let entries = history_manager
            .get_history_entries()
            .await
            .expect("query final meeting history");
        assert_eq!(entries.len(), 1);
        let meeting_entry = &entries[0];
        assert_eq!(meeting_entry.id, meeting_history_id);
        assert_eq!(meeting_entry.recording_source, "full_system_audio");
        assert!(meeting_entry
            .transcription_text
            .contains("meeting chunk captured after nested cancellation"));
        assert!(!meeting_entry
            .transcription_text
            .contains("cancel this nested dictation"));
        assert!(history_manager
            .get_audio_file_path(&meeting_entry.file_name)
            .exists());
    }

    #[tokio::test]
    async fn fallback_completion_ownership_survives_until_blocked_save_finishes() {
        struct DropProbe(Arc<AtomicUsize>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }

        let drops = Arc::new(AtomicUsize::new(0));
        let mut owner = CompletionOwner::new(DropProbe(Arc::clone(&drops)));
        let transferred = owner.transfer();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _completion_owner = transferred;
            let _ = started_tx.send(());
            let _ = release_rx.await;
        });

        let _ = started_rx.await;
        drop(owner);
        assert_eq!(drops.load(Ordering::Relaxed), 0);

        let _ = release_tx.send(());
        task.await.unwrap();
        assert_eq!(drops.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn full_system_stop_payload_keeps_missing_microphone_tail() {
        let mut mixed = vec![0.25];
        let mut microphone = Vec::new();
        let mut system_audio = vec![0.5];

        append_full_system_stop_tail_samples(
            &mut mixed,
            &mut microphone,
            &mut system_audio,
            FullSystemSessionTranscriptionSamples {
                mixed: Some(vec![9.0, 9.0]),
                sources: vec![
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::Microphone,
                        samples: vec![0.1, 0.2],
                    },
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::SystemAudio,
                        samples: vec![0.9, 0.8],
                    },
                ],
            },
        );

        assert_eq!(mixed, vec![0.25]);
        assert_eq!(microphone, vec![0.1, 0.2]);
        assert_eq!(system_audio, vec![0.5, 0.9, 0.8]);
    }

    #[test]
    fn full_system_stop_payload_appends_source_tail_to_existing_buffers() {
        let mut mixed = vec![0.25];
        let mut microphone = vec![0.01, 0.02];
        let mut system_audio = vec![0.5];

        append_full_system_stop_tail_samples(
            &mut mixed,
            &mut microphone,
            &mut system_audio,
            FullSystemSessionTranscriptionSamples {
                mixed: Some(vec![9.0, 9.0]),
                sources: vec![
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::Microphone,
                        samples: vec![0.1, 0.2],
                    },
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::SystemAudio,
                        samples: vec![0.9, 0.8],
                    },
                ],
            },
        );

        assert_eq!(mixed, vec![0.25]);
        assert_eq!(microphone, vec![0.01, 0.02, 0.1, 0.2]);
        assert_eq!(system_audio, vec![0.5, 0.9, 0.8]);
    }

    #[test]
    fn quick_dictation_restore_requires_matching_active_meeting_binding() {
        let context = TranscriptionCompletionContext::ReturnToMeeting {
            binding_id: "transcribe_full_system_audio".to_string(),
            operation_id: 11,
        };

        assert!(should_restore_meeting_ui(
            &context,
            Some("transcribe_full_system_audio")
        ));
        assert!(!should_restore_meeting_ui(&context, Some("transcribe")));
        assert!(!should_restore_meeting_ui(&context, None));
    }

    #[test]
    fn stale_quick_dictation_cannot_restore_over_newer_quick_ui() {
        ACTIVE_QUICK_DICTATION_UI_OPERATION.store(12, Ordering::Release);
        let stale = TranscriptionCompletionContext::ReturnToMeeting {
            binding_id: "transcribe_full_system_audio".to_string(),
            operation_id: 11,
        };
        let current = TranscriptionCompletionContext::ReturnToMeeting {
            binding_id: "transcribe_full_system_audio".to_string(),
            operation_id: 12,
        };

        assert!(!quick_dictation_ui_restore_is_current(&stale));
        assert!(quick_dictation_ui_restore_is_current(&current));

        ACTIVE_QUICK_DICTATION_UI_OPERATION.store(0, Ordering::Release);
    }

    #[test]
    fn standalone_dictation_never_restores_meeting_ui() {
        assert!(!should_restore_meeting_ui(
            &TranscriptionCompletionContext::Standalone,
            Some("transcribe_full_system_audio")
        ));
    }

    #[test]
    fn system_only_meeting_quick_dictation_still_restores_meeting_context() {
        let context = completion_context_for_active_meeting(
            Some("transcribe_full_system_audio".to_string()),
            11,
        );

        assert!(matches!(
            context,
            TranscriptionCompletionContext::ReturnToMeeting { ref binding_id, .. }
                if binding_id == "transcribe_full_system_audio"
        ));
    }

    #[test]
    fn vocabulary_block_normalizes_and_warns_against_insertion() {
        let terms = vec![
            " Zach Latta ".to_string(),
            "zach latta".to_string(),
            "Prime Directive".to_string(),
        ];

        let block = custom_vocabulary_prompt_block(&terms).unwrap();

        assert!(block.contains("- Zach Latta"));
        assert!(block.contains("- Prime Directive"));
        assert_eq!(block.matches("Zach Latta").count(), 1);
        assert!(block.contains("do not insert terms that were not spoken"));
    }

    #[test]
    fn post_process_prompt_includes_vocabulary_and_context() {
        let mut settings = get_default_settings();
        settings.custom_vocabulary_terms = vec!["FreeFlow".to_string()];
        let context = AppContextSnapshot {
            app_name: Some("Terminal".to_string()),
            window_title: Some("uttr".to_string()),
            ..Default::default()
        };

        let prompt = resolved_post_process_system_prompt(&settings, Some(&context)).unwrap();

        assert!(prompt.contains("FreeFlow"));
        assert!(prompt.contains("Nearby app context"));
        assert!(prompt.contains("Terminal"));
    }

    #[test]
    fn ask_selection_prompt_uses_selection_as_context() {
        let context = AppContextSnapshot {
            app_name: Some("Notes".to_string()),
            selected_text: Some("selected text".to_string()),
            ..Default::default()
        };
        let prompt = build_ask_selection_prompt(
            "This is too long.",
            "make this shorter",
            &context,
            &["Prime Directive".to_string()],
        );

        assert!(prompt.contains("# Spoken request\nmake this shorter"));
        assert!(prompt.contains("# Selected text\nThis is too long."));
        assert!(prompt.contains("using the selected text as context"));
        assert!(prompt.contains("Prime Directive"));
        assert!(prompt.contains("<uttr_ask_output>"));
    }

    #[test]
    fn ask_selection_prompt_without_selection_behaves_like_chat() {
        let context = AppContextSnapshot {
            app_name: Some("Notes".to_string()),
            ..Default::default()
        };
        let prompt = build_ask_selection_prompt("", "why is the sky blue?", &context, &Vec::new());

        assert!(prompt.contains("# Spoken request\nwhy is the sky blue?"));
        assert!(prompt.contains("No selected text was provided"));
        assert!(prompt.contains("chat question"));
        assert!(!prompt.contains("# Selected text"));
        assert!(prompt.contains("<uttr_ask_output>"));
    }

    #[test]
    fn ask_selection_payload_includes_session_selected_text() {
        let _guard = ASK_SELECTION_TEST_LOCK.lock().unwrap();
        clear_ask_selection_session();
        let session_id = current_ask_selection_session_id();
        update_ask_selection_session(
            session_id,
            None,
            Some("  selected text  ".to_string()),
            AppContextSnapshot::default(),
            vec![ask_selection_message("user", "summarize this", false)],
        );

        let payload = ask_selection_payload(
            "result",
            Some(session_id),
            current_ask_selection_messages(),
            Some("summary".to_string()),
            None,
        );

        assert_eq!(payload.selected_text.as_deref(), Some("selected text"));
        clear_ask_selection_session();
    }

    #[test]
    fn clean_ask_selection_response_prefers_ask_tag() {
        let cleaned = clean_ask_selection_response(
            "notes <uttr_ask_output>\nShorter text.\n</uttr_ask_output>",
        );

        assert_eq!(cleaned, "Shorter text.");
    }

    #[test]
    fn ask_selection_follow_up_prompt_keeps_selected_text_and_prior_chat() {
        let context = AppContextSnapshot {
            app_name: Some("Google Docs".to_string()),
            window_title: Some("Market notes".to_string()),
            ..Default::default()
        };
        let messages = vec![
            ask_selection_message("user", "What is the risk?", false),
            ask_selection_message("assistant", "The buyer is unclear.", false),
            ask_selection_message("assistant", "Thinking...", true),
        ];

        let prompt = build_ask_selection_follow_up_prompt(
            "Counselor overload is real, but buyer urgency is unproven.",
            &messages,
            "make it sharper",
            &context,
            &["FreeFlow".to_string()],
        );

        assert!(prompt.contains("# Latest follow-up\nmake it sharper"));
        assert!(prompt.contains("User: What is the risk?"));
        assert!(prompt.contains("Assistant: The buyer is unclear."));
        assert!(prompt.contains("# Original selected text\nCounselor overload"));
        assert!(
            prompt.find("# Prior chat").unwrap() < prompt.find("# Original selected text").unwrap()
        );
        assert!(!prompt.contains("Thinking..."));
        assert!(prompt.contains("Google Docs"));
        assert!(prompt.contains("FreeFlow"));
        assert!(prompt.contains("<uttr_ask_output>"));
    }

    #[test]
    fn ask_selection_follow_up_prompt_keeps_original_selection_as_background() {
        let messages = vec![
            ask_selection_message(
                "user",
                "This is for a German passport renewal. What do I put for these two things?",
                false,
            ),
            ask_selection_message(
                "assistant",
                "If you do not have a doctoral title or religious/stage name, leave those fields blank.",
                false,
            ),
            ask_selection_message(
                "user",
                "what do these mean? Erwerb der deutschen Staatsangehörigkeit als Kind eines/einer Deutschen durch Geburt",
                false,
            ),
            ask_selection_message(
                "assistant",
                "These options describe how you acquired German citizenship.",
                false,
            ),
        ];

        let prompt = build_ask_selection_follow_up_prompt(
            "Doktorgrad/ Doctoral title 11. Ordens-/ Künstlername/ Religious/Stage name",
            &messages,
            "my mother was german",
            &AppContextSnapshot::default(),
            &Vec::new(),
        );

        assert!(prompt.contains("# Latest follow-up\nmy mother was german"));
        assert!(prompt.contains("Use the original selected text only as background"));
        assert!(prompt.contains("# Prior chat"));
        assert!(prompt.contains("Erwerb der deutschen Staatsangehörigkeit"));
        assert!(prompt.contains("# Original selected text\nDoktorgrad/ Doctoral title"));
        assert!(
            prompt.find("# Prior chat").unwrap() < prompt.find("# Original selected text").unwrap()
        );
        assert!(!prompt.contains("# Selected text"));
    }

    #[test]
    fn ask_selection_follow_up_prompt_without_selection_uses_prior_chat() {
        let context = AppContextSnapshot {
            app_name: Some("Notes".to_string()),
            ..Default::default()
        };
        let messages = vec![
            ask_selection_message("user", "What is Rust?", false),
            ask_selection_message("assistant", "Rust is a systems language.", false),
            ask_selection_message("assistant", "Thinking...", true),
        ];

        let prompt = build_ask_selection_follow_up_prompt(
            "",
            &messages,
            "make it shorter",
            &context,
            &Vec::new(),
        );

        assert!(prompt.contains("# Latest follow-up\nmake it shorter"));
        assert!(prompt.contains("User: What is Rust?"));
        assert!(prompt.contains("Assistant: Rust is a systems language."));
        assert!(!prompt.contains("Thinking..."));
        assert!(!prompt.contains("# Selected text"));
        assert!(!prompt.contains("# Original selected text"));
        assert!(prompt.contains("<uttr_ask_output>"));
    }

    #[test]
    fn clear_ask_selection_session_drops_prior_messages() {
        let _guard = ASK_SELECTION_TEST_LOCK.lock().unwrap();
        clear_ask_selection_session();
        let session_id = current_ask_selection_session_id();
        update_ask_selection_session(
            session_id,
            None,
            Some("selected text".to_string()),
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Previous answer", false)],
        );

        assert_eq!(current_ask_selection_messages().len(), 1);
        assert!(ask_selection_session_is_current(session_id));

        clear_ask_selection_session();

        assert!(current_ask_selection_messages().is_empty());
        assert!(!ask_selection_session_is_current(session_id));
        assert_ne!(current_ask_selection_session_id(), session_id);
    }

    #[test]
    fn stale_ask_selection_cancel_cannot_hide_newer_session() {
        let _guard = ASK_SELECTION_TEST_LOCK.lock().unwrap();
        clear_ask_selection_session();
        let old_session_id = current_ask_selection_session_id();
        update_ask_selection_session(
            old_session_id,
            Some(41),
            None,
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Thinking...", true)],
        );
        clear_ask_selection_session();
        let new_session_id = current_ask_selection_session_id();
        update_ask_selection_session(
            new_session_id,
            Some(42),
            None,
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Thinking...", true)],
        );

        let stale_hide_called = AtomicBool::new(false);
        assert!(!cancel_ask_selection_session_if_owned(41, || {
            stale_hide_called.store(true, Ordering::Relaxed);
        }));
        assert!(!stale_hide_called.load(Ordering::Relaxed));
        assert!(ask_selection_session_is_current(new_session_id));

        let current_hide_called = AtomicBool::new(false);
        assert!(cancel_ask_selection_session_if_owned(42, || {
            current_hide_called.store(true, Ordering::Relaxed);
        }));
        assert!(current_hide_called.load(Ordering::Relaxed));
        assert!(!ask_selection_session_is_current(new_session_id));
    }

    #[test]
    fn cancelled_ask_selection_cannot_publish_thinking_panel() {
        let _guard = ASK_SELECTION_TEST_LOCK.lock().unwrap();
        clear_ask_selection_session();
        let operation_id = u64::MAX - 61;
        cancel_dictation_operation(operation_id);
        let session_id = current_ask_selection_session_id();
        let publish_called = AtomicBool::new(false);

        assert!(!publish_new_ask_selection_session_if_active(
            operation_id,
            session_id,
            Some(operation_id),
            None,
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Thinking...", true)],
            || publish_called.store(true, Ordering::Relaxed),
        ));
        assert!(!publish_called.load(Ordering::Relaxed));
        assert!(!ask_selection_session_is_current(session_id));
    }

    #[tokio::test]
    async fn cancellation_after_ask_selection_save_rolls_back_row_and_wav() {
        let _guard = ASK_SELECTION_TEST_LOCK.lock().unwrap();
        clear_ask_selection_session();
        let root = tempfile::tempdir().expect("create history root");
        let history_manager =
            HistoryManager::new_for_test(root.path()).expect("create test history manager");
        let operation_id = u64::MAX - 62;
        let session_id = current_ask_selection_session_id();
        assert!(publish_new_ask_selection_session_if_active(
            operation_id,
            session_id,
            Some(operation_id),
            None,
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Thinking...", true)],
            || {},
        ));
        let entry_id = history_manager
            .save_transcription(
                vec![0.05; 1_600],
                "Explain this.".to_string(),
                Some("Explanation".to_string()),
                Some("Ask Selection".to_string()),
                "dictation",
            )
            .await
            .expect("save Ask Selection before cancellation");

        cancel_dictation_operation(operation_id);
        assert!(cancel_ask_selection_session_if_owned(operation_id, || {}));
        let result_publish_called = AtomicBool::new(false);
        assert!(!complete_ask_selection_session_with_rollback(
            &history_manager,
            Some(entry_id),
            operation_id,
            session_id,
            None,
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Explanation", false)],
            || result_publish_called.store(true, Ordering::Relaxed),
        ));

        assert!(!result_publish_called.load(Ordering::Relaxed));
        assert!(history_manager
            .get_history_entries()
            .await
            .expect("query rolled back Ask Selection history")
            .is_empty());
        assert_eq!(
            std::fs::read_dir(root.path().join("recordings"))
                .expect("read rolled back recordings")
                .count(),
            0
        );
    }

    #[test]
    fn operation_cancel_suppresses_nested_and_stopping_dictation_errors() {
        for operation_id in [u64::MAX - 63, u64::MAX - 64] {
            cancel_dictation_operation(operation_id);
            let publish_called = AtomicBool::new(false);
            assert!(!publish_transcription_error_if_operation_active(
                operation_id,
                || publish_called.store(true, Ordering::Relaxed),
            ));
            assert!(!publish_called.load(Ordering::Relaxed));
        }
    }

    #[test]
    fn dictation_completion_and_cancel_have_exactly_one_terminal_winner() {
        let cancelled_operation = u64::MAX - 65;
        assert!(cancel_dictation_operation(cancelled_operation));
        let cancelled_completion = AtomicBool::new(false);
        assert!(!complete_dictation_operation_if_active(
            cancelled_operation,
            || cancelled_completion.store(true, Ordering::Relaxed),
        ));
        assert!(!cancelled_completion.load(Ordering::Relaxed));
        assert!(!cancel_dictation_operation(cancelled_operation));

        let completed_operation = u64::MAX - 66;
        let completion = AtomicBool::new(false);
        assert!(complete_dictation_operation_if_active(
            completed_operation,
            || completion.store(true, Ordering::Relaxed),
        ));
        assert!(completion.load(Ordering::Relaxed));
        assert!(!cancel_dictation_operation(completed_operation));
        assert!(!complete_dictation_operation_if_active(
            completed_operation,
            || panic!("a terminal operation must not complete twice"),
        ));
    }

    #[test]
    fn terminal_operations_remain_terminal_until_released() {
        let cancelled_operation = u64::MAX - 10_000;
        assert!(cancel_dictation_operation(cancelled_operation));

        let mut completed_operations = Vec::new();
        for offset in 1..=2_048 {
            let operation_id = cancelled_operation + offset;
            assert!(complete_dictation_operation_if_active(operation_id, || {}));
            completed_operations.push(operation_id);
        }

        assert!(!complete_dictation_operation_if_active(
            cancelled_operation,
            || panic!("an old cancelled operation must never be revived"),
        ));

        for operation_id in completed_operations {
            release_dictation_operation(operation_id);
        }
        release_dictation_operation(cancelled_operation);

        assert!(complete_dictation_operation_if_active(
            cancelled_operation,
            || {},
        ));
        release_dictation_operation(cancelled_operation);
    }

    #[tokio::test]
    async fn cancellation_after_standard_dictation_save_rolls_back_before_paste_commit() {
        let root = tempfile::tempdir().expect("create history root");
        let history_manager =
            HistoryManager::new_for_test(root.path()).expect("create test history manager");
        let operation_id = u64::MAX - 67;
        let entry_id = history_manager
            .save_transcription(
                vec![0.05; 1_600],
                "do not paste this".to_string(),
                None,
                None,
                "dictation",
            )
            .await
            .expect("save dictation before cancellation");

        assert!(cancel_dictation_operation(operation_id));
        let pasted = AtomicBool::new(false);
        assert!(!complete_persisted_dictation_if_active(
            &history_manager,
            Some(entry_id),
            operation_id,
            || pasted.store(true, Ordering::Relaxed),
        ));

        assert!(!pasted.load(Ordering::Relaxed));
        assert!(history_manager
            .get_history_entries()
            .await
            .expect("query rolled back standard dictation")
            .is_empty());
        assert_eq!(
            std::fs::read_dir(root.path().join("recordings"))
                .expect("read rolled back recordings")
                .count(),
            0
        );
    }

    #[test]
    fn cancelled_dictation_cannot_publish_no_input_feedback() {
        let operation_id = u64::MAX - 68;
        assert!(cancel_dictation_operation(operation_id));
        let feedback_published = AtomicBool::new(false);

        assert!(!complete_transcription_ui_if_active(
            TranscriptionCompletionMode::Standard,
            operation_id,
            || feedback_published.store(true, Ordering::Relaxed),
        ));
        assert!(!feedback_published.load(Ordering::Relaxed));
    }

    #[test]
    fn post_process_toggle_flips_enabled_setting() {
        let mut settings = get_default_settings();
        settings.post_process_enabled = false;

        assert!(toggle_post_process_enabled(&mut settings));
        assert!(settings.post_process_enabled);

        assert!(!toggle_post_process_enabled(&mut settings));
        assert!(!settings.post_process_enabled);
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
    fn live_final_chunk_timeout_includes_extra_shutdown_budget() {
        let sample_count = 16_000 * 60;
        let chunk = FullSystemLiveChunk {
            mixed_samples: vec![0.1; sample_count],
            source_samples: Vec::new(),
        };
        assert_eq!(
            full_system_live_final_chunk_timeout(&chunk),
            full_system_live_chunk_transcription_timeout(&chunk)
                + FULL_SYSTEM_LIVE_FINAL_CHUNK_EXTRA_TIMEOUT
        );
    }

    #[test]
    fn live_final_chunk_timeout_covers_both_source_transcriptions() {
        let sample_count = 16_000 * FULL_SYSTEM_LIVE_CHUNK_SECONDS;
        let chunk = FullSystemLiveChunk {
            mixed_samples: vec![0.1; sample_count],
            source_samples: vec![
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: vec![0.1; sample_count],
                },
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.1; sample_count],
                },
            ],
        };
        let two_source_transcription_budget =
            transcription_timeout_for_samples(sample_count).saturating_mul(2);

        assert!(
            full_system_live_final_chunk_timeout(&chunk) > two_source_transcription_budget,
            "the aggregate final-chunk timeout must not cancel the second source transcription"
        );
    }

    #[tokio::test]
    async fn live_two_source_transcription_commits_both_labeled_segments() {
        let sample_count = 16_000;
        let chunk = FullSystemLiveChunk {
            mixed_samples: vec![0.1; sample_count],
            source_samples: vec![
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: vec![0.1; sample_count],
                },
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.1; sample_count],
                },
            ],
        };

        let segments =
            transcribe_full_system_live_chunk_sources_with(chunk, 1, |_, source, _| async move {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                let text = match source {
                    Some("full_system_audio_microphone") => "local speaker",
                    Some("full_system_audio_system") => "remote speaker",
                    unexpected => panic!("unexpected transcription source: {unexpected:?}"),
                };
                Ok::<String, anyhow::Error>(text.to_string())
            })
            .await
            .expect("both source transcriptions");

        let runtime = FullSystemLiveRuntime::new();
        commit_full_system_live_transcription_segments(&runtime, &segments, false)
            .expect("two-source transcript commit");

        assert_eq!(
            runtime.transcript_text.lock().unwrap().as_str(),
            "Me: local speaker\n\nThem: remote speaker"
        );
        assert_eq!(runtime.chunk_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn live_microphone_failure_preserves_system_transcript() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_for_transcriber = Arc::clone(&calls);
        let segments = transcribe_full_system_live_chunk_sources_with(
            two_source_live_chunk(),
            1,
            move |_, source, _| {
                let calls = Arc::clone(&calls_for_transcriber);
                async move {
                    let source = source.expect("labeled source id");
                    calls.lock().unwrap().push(source);
                    match source {
                        "full_system_audio_microphone" => {
                            Err(anyhow::anyhow!("microphone provider failed"))
                        }
                        "full_system_audio_system" => Ok("remote speaker".to_string()),
                        unexpected => panic!("unexpected transcription source: {unexpected}"),
                    }
                }
            },
        )
        .await
        .expect("system transcript survives microphone failure");

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &["full_system_audio_microphone", "full_system_audio_system"]
        );
        assert_eq!(
            segments,
            vec![LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::SystemAudio,
                text: "remote speaker".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn live_system_failure_preserves_microphone_transcript() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_for_transcriber = Arc::clone(&calls);
        let segments = transcribe_full_system_live_chunk_sources_with(
            two_source_live_chunk(),
            1,
            move |_, source, _| {
                let calls = Arc::clone(&calls_for_transcriber);
                async move {
                    let source = source.expect("labeled source id");
                    calls.lock().unwrap().push(source);
                    match source {
                        "full_system_audio_microphone" => Ok("local speaker".to_string()),
                        "full_system_audio_system" => {
                            Err(anyhow::anyhow!("system provider failed"))
                        }
                        unexpected => panic!("unexpected transcription source: {unexpected}"),
                    }
                }
            },
        )
        .await
        .expect("microphone transcript survives system failure");

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &["full_system_audio_microphone", "full_system_audio_system"]
        );
        assert_eq!(
            segments,
            vec![LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "local speaker".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn live_all_source_failures_return_error_after_both_attempts() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_for_transcriber = Arc::clone(&calls);
        let error = transcribe_full_system_live_chunk_sources_with(
            two_source_live_chunk(),
            1,
            move |_, source, _| {
                let calls = Arc::clone(&calls_for_transcriber);
                async move {
                    let source = source.expect("labeled source id");
                    calls.lock().unwrap().push(source);
                    Err::<String, anyhow::Error>(anyhow::anyhow!("{source} failed"))
                }
            },
        )
        .await
        .expect_err("all source failures must fail the chunk");

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &["full_system_audio_microphone", "full_system_audio_system"]
        );
        assert!(error
            .to_string()
            .contains("Live source transcription failed for chunk 1"));
    }

    #[tokio::test]
    async fn live_stop_recovery_orders_in_flight_before_pending_without_rerecording() {
        let runtime = FullSystemLiveRuntime::new();
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend_from_slice(&[0.1, 0.2]);
        {
            let mut audio = runtime.audio_state.lock().unwrap();
            audio.in_flight_chunk = Some(FullSystemLiveInFlightChunk {
                chunk: FullSystemLiveChunk {
                    mixed_samples: vec![0.1, 0.2],
                    source_samples: vec![FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::Microphone,
                        samples: vec![0.1, 0.2],
                    }],
                },
                transcription_task: completed_live_transcription_task(Vec::new()),
            });
            audio.pending_samples.push(0.3);
            audio.pending_system_audio_samples.push(0.3);
        }

        let chunks = take_full_system_live_finalization_chunks(
            &runtime,
            Some(FullSystemSessionTranscriptionSamples {
                mixed: Some(vec![9.0]),
                sources: vec![FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.4],
                }],
            }),
        );

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chunk.mixed_samples, vec![0.1, 0.2]);
        assert!(!chunks[0].record_samples);
        assert!(chunks[0].transcription_task.is_some());
        assert_eq!(chunks[1].chunk.mixed_samples, vec![0.3, 0.4]);
        assert!(chunks[1].record_samples);
        assert!(chunks[1].transcription_task.is_none());
        assert_eq!(
            runtime.recorded_samples.lock().unwrap().as_slice(),
            &[0.1, 0.2]
        );
        let audio = runtime.audio_state.lock().unwrap();
        assert!(audio.in_flight_chunk.is_none());
        assert!(audio.pending_samples.is_empty());
        assert!(audio.pending_system_audio_samples.is_empty());
    }

    #[tokio::test]
    async fn live_chunk_drain_keeps_older_in_flight_and_newer_remainder_recoverable() {
        let runtime = FullSystemLiveRuntime::new();
        let mut mixed = vec![0.1; FULL_SYSTEM_LIVE_CHUNK_SAMPLES];
        mixed.extend(vec![0.2; FULL_SYSTEM_LIVE_CHUNK_SAMPLES]);
        let mut microphone = vec![0.1; FULL_SYSTEM_LIVE_CHUNK_SAMPLES];
        microphone.extend(vec![0.2; FULL_SYSTEM_LIVE_CHUNK_SAMPLES]);
        append_full_system_live_audio_delta(
            &mut runtime.audio_state.lock().unwrap(),
            FullSystemSessionTranscriptionSamples {
                mixed: Some(mixed),
                sources: vec![FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: microphone,
                }],
            },
        );

        let drained = take_next_full_system_live_chunk(&runtime, |_, _| {
            completed_live_transcription_task(Vec::new())
        })
        .expect("first live chunk");
        assert_eq!(
            drained.chunk.mixed_samples.len(),
            FULL_SYSTEM_LIVE_CHUNK_SAMPLES
        );
        assert_eq!(drained.chunk.mixed_samples[0], 0.1);

        let chunks = take_full_system_live_finalization_chunks(&runtime, None);

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chunk.mixed_samples[0], 0.1);
        assert!(!chunks[0].record_samples);
        assert_eq!(chunks[1].chunk.mixed_samples[0], 0.2);
        assert_eq!(
            chunks[1].chunk.mixed_samples.len(),
            FULL_SYSTEM_LIVE_CHUNK_SAMPLES
        );
        assert!(chunks[1].record_samples);
    }

    #[tokio::test]
    async fn live_stop_waits_for_blocked_in_flight_commit_without_replay_or_wav_duplication() {
        let runtime = Arc::new(FullSystemLiveRuntime::new());
        let samples = vec![0.1; FULL_SYSTEM_LIVE_CHUNK_SAMPLES];
        append_full_system_live_audio_delta(
            &mut runtime.audio_state.lock().unwrap(),
            FullSystemSessionTranscriptionSamples {
                mixed: Some(samples.clone()),
                sources: vec![
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::Microphone,
                        samples: samples.clone(),
                    },
                    FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::SystemAudio,
                        samples,
                    },
                ],
            },
        );

        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let provider_calls = Arc::new(Mutex::new(Vec::new()));
        let task_started = Arc::clone(&started);
        let task_release = Arc::clone(&release);
        let task_calls = Arc::clone(&provider_calls);
        let in_flight = take_next_full_system_live_chunk(&runtime, move |chunk, chunk_index| {
            Arc::new(tokio::sync::Mutex::new(tauri::async_runtime::spawn(
                async move {
                    transcribe_full_system_live_chunk_sources_with(
                        chunk,
                        chunk_index,
                        move |_, source, _| {
                            let started = Arc::clone(&task_started);
                            let release = Arc::clone(&task_release);
                            let calls = Arc::clone(&task_calls);
                            async move {
                                let source = source.expect("labeled source id");
                                calls.lock().unwrap().push(source);
                                let text = match source {
                                    "full_system_audio_microphone" => {
                                        started.notify_one();
                                        release.notified().await;
                                        "local speaker"
                                    }
                                    "full_system_audio_system" => "remote speaker",
                                    unexpected => {
                                        panic!("unexpected transcription source: {unexpected}")
                                    }
                                };
                                Ok::<String, anyhow::Error>(text.to_string())
                            }
                        },
                    )
                    .await
                },
            )))
        })
        .expect("blocked in-flight live chunk");
        record_full_system_live_chunk_samples(&runtime, &in_flight.chunk);

        let worker_runtime = Arc::clone(&runtime);
        let worker_task = Arc::clone(&in_flight.transcription_task);
        let worker = tauri::async_runtime::spawn(async move {
            let segments = await_full_system_live_transcription_task(&worker_task)
                .await
                .expect("worker transcription result");
            commit_full_system_live_transcription_segments(&worker_runtime, &segments, true)
                .expect("blocked chunk transcript commit");
        });

        started.notified().await;
        runtime.stop_requested.store(true, Ordering::Relaxed);
        await_full_system_live_worker_stop(worker, std::time::Duration::from_millis(1)).await;

        release.notify_one();
        let finalization_chunks = take_full_system_live_finalization_chunks(&runtime, None);
        assert_eq!(finalization_chunks.len(), 1);
        let recovered = &finalization_chunks[0];
        let segments = await_full_system_live_transcription_task(
            recovered
                .transcription_task
                .as_ref()
                .expect("retained in-flight transcription task"),
        )
        .await
        .expect("stop resumes original transcription task");
        commit_full_system_live_transcription_segments(&runtime, &segments, false)
            .expect("stop-side transcript commit");

        assert_eq!(
            runtime.transcript_text.lock().unwrap().as_str(),
            "Me: local speaker\n\nThem: remote speaker"
        );
        assert_eq!(
            runtime.recorded_samples.lock().unwrap().len(),
            FULL_SYSTEM_LIVE_CHUNK_SAMPLES
        );
        assert_eq!(runtime.chunk_count.load(Ordering::Relaxed), 1);
        assert_eq!(
            provider_calls.lock().unwrap().as_slice(),
            &["full_system_audio_microphone", "full_system_audio_system"]
        );
    }

    #[tokio::test]
    async fn live_hard_timeout_saves_complete_wav_and_reaps_without_tail_replay() {
        let runtime = FullSystemLiveRuntime::new();
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend_from_slice(&[0.1, 0.2]);

        let release = Arc::new(tokio::sync::Notify::new());
        let late_task_completed = Arc::new(AtomicBool::new(false));
        let task_release = Arc::clone(&release);
        let task_completed = Arc::clone(&late_task_completed);
        let transcription_task = Arc::new(tokio::sync::Mutex::new(tauri::async_runtime::spawn(
            async move {
                task_release.notified().await;
                task_completed.store(true, Ordering::Release);
                Ok(vec![LabeledTranscriptSegment {
                    source: FullSystemTranscriptionSource::Microphone,
                    text: "late transcript".to_string(),
                }])
            },
        )));
        {
            let mut audio = runtime.audio_state.lock().unwrap();
            audio.in_flight_chunk = Some(FullSystemLiveInFlightChunk {
                chunk: FullSystemLiveChunk {
                    mixed_samples: vec![0.1, 0.2],
                    source_samples: vec![FullSystemTranscriptionSourceSamples {
                        source: FullSystemTranscriptionSource::Microphone,
                        samples: vec![0.1, 0.2],
                    }],
                },
                transcription_task: Arc::clone(&transcription_task),
            });
            audio.pending_samples.push(0.3);
            audio.pending_system_audio_samples.push(0.3);
        }

        let finalization_chunks = take_full_system_live_finalization_chunks(
            &runtime,
            Some(FullSystemSessionTranscriptionSamples {
                mixed: None,
                sources: vec![FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.4],
                }],
            }),
        );
        record_full_system_live_finalization_audio(&runtime, &finalization_chunks);

        assert_eq!(finalization_chunks.len(), 2);
        assert_eq!(
            runtime.recorded_samples.lock().unwrap().as_slice(),
            &[0.1, 0.2, 0.3, 0.4]
        );
        assert!(finalization_chunks[1].transcription_task.is_none());
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(1),
            await_full_system_live_transcription_task(&transcription_task),
        )
        .await
        .is_err());

        reap_full_system_live_transcription_task(Arc::clone(&transcription_task));
        release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !late_task_completed.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late transcription reaper completed");

        assert!(runtime.transcript_text.lock().unwrap().is_empty());
        assert_eq!(runtime.chunk_count.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn live_first_chunk_timeout_persists_audio_without_a_transcript() {
        let root = tempfile::tempdir().expect("create history root");
        let history_manager =
            HistoryManager::new_for_test(root.path()).expect("create test history manager");
        let runtime = FullSystemLiveRuntime::new();
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend_from_slice(&[0.1, 0.2, 0.3]);
        runtime
            .final_transcription_timed_out
            .store(true, Ordering::Relaxed);
        *runtime.summary_text.lock().unwrap() = Some(
            "Audio was saved, but final transcription timed out. The transcript may be incomplete."
                .to_string(),
        );

        let live_final = snapshot_full_system_live_runtime(&runtime).expect("audio-only snapshot");
        assert!(live_final.transcript_text.is_empty());
        assert!(!live_final.final_transcription_failed);
        assert!(should_persist_full_system_live_final(&live_final));

        let history_entry_id = persist_full_system_live_final(&history_manager, &live_final)
            .await
            .expect("persist audio-only timed-out meeting");
        let entries = history_manager
            .get_history_entries()
            .await
            .expect("query audio-only timed-out meeting");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, history_entry_id);
        assert!(entries[0].transcription_text.is_empty());
        assert!(entries[0]
            .post_processed_text
            .as_deref()
            .is_some_and(|notice| notice.contains("final transcription timed out")));
        let audio_path = history_manager.get_audio_file_path(&entries[0].file_name);
        assert!(audio_path.exists());
        let audio_reader = hound::WavReader::open(audio_path).expect("open persisted timeout WAV");
        assert_eq!(audio_reader.duration(), 3);

        let ordinary_audio_only_runtime = FullSystemLiveRuntime::new();
        ordinary_audio_only_runtime
            .recorded_samples
            .lock()
            .unwrap()
            .push(0.1);
        let ordinary_audio_only = snapshot_full_system_live_runtime(&ordinary_audio_only_runtime)
            .expect("ordinary audio-only snapshot");
        assert!(!should_persist_full_system_live_final(&ordinary_audio_only));
    }

    #[tokio::test]
    async fn live_non_timeout_transcription_failure_persists_audio_without_a_transcript() {
        let root = tempfile::tempdir().expect("create history root");
        let history_manager =
            HistoryManager::new_for_test(root.path()).expect("create test history manager");
        let runtime = FullSystemLiveRuntime::new();
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend_from_slice(&[0.1, 0.2, 0.3, 0.4]);
        mark_full_system_live_transcription_failure(&runtime, false);

        let live_final = snapshot_full_system_live_runtime(&runtime)
            .expect("audio-only failed-transcription snapshot");
        assert!(live_final.transcript_text.is_empty());
        assert!(live_final.final_transcription_failed);
        assert!(!live_final.final_transcription_timed_out);
        assert!(should_persist_full_system_live_final(&live_final));
        assert!(live_final
            .summary_text
            .as_deref()
            .is_some_and(|notice| notice.contains("transcription failed")));

        let history_entry_id = persist_full_system_live_final(&history_manager, &live_final)
            .await
            .expect("persist audio-only failed-transcription meeting");
        let entries = history_manager
            .get_history_entries()
            .await
            .expect("query audio-only failed-transcription meeting");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, history_entry_id);
        assert!(entries[0].transcription_text.is_empty());
        assert!(entries[0]
            .post_processed_text
            .as_deref()
            .is_some_and(|notice| notice.contains("transcription failed")));
        let audio_path = history_manager.get_audio_file_path(&entries[0].file_name);
        assert!(audio_path.exists());
        let audio_reader =
            hound::WavReader::open(audio_path).expect("open persisted transcription-failure WAV");
        assert_eq!(audio_reader.duration(), 4);
    }

    #[tokio::test]
    async fn live_worker_stop_awaits_cancellation_before_recovery() {
        struct DropProbe(Arc<AtomicBool>);

        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let worker_dropped = Arc::clone(&dropped);
        let worker = tauri::async_runtime::spawn(async move {
            let _probe = DropProbe(worker_dropped);
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;

        await_full_system_live_worker_stop(worker, std::time::Duration::from_millis(1)).await;

        assert!(dropped.load(Ordering::Acquire));
    }

    #[test]
    fn live_summary_quota_errors_are_user_facing() {
        let raw = r#"API request failed with status 429 Too Many Requests: {
          "error": {
            "message": "You exceeded your current quota, please check your plan and billing details.",
            "type": "insufficient_quota",
            "code": "insufficient_quota"
          }
        }"#;

        let friendly = friendly_live_summary_error(raw);

        assert_eq!(
            friendly,
            "OpenAI quota is exhausted for the saved API key. Recording continues, but live summaries are paused for this session."
        );
        assert!(should_pause_live_summaries(raw));
        assert!(!friendly.contains('{'));
        assert!(!friendly.contains("insufficient_quota"));
    }

    #[test]
    fn live_summary_updates_every_minute_and_on_final_chunk() {
        assert_eq!(FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL, 6);
        assert!(!should_update_live_summary(1, false));
        assert!(!should_update_live_summary(5, false));
        assert!(should_update_live_summary(6, false));
        assert!(!should_update_live_summary(7, false));
        assert!(should_update_live_summary(12, false));
        assert!(should_update_live_summary(3, true));
    }

    #[test]
    fn labeled_meeting_transcript_formats_source_blocks() {
        let rendered = format_labeled_transcript_segments(&[
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "I want the transcript labels.".to_string(),
            },
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::SystemAudio,
                text: "Use source labels first.".to_string(),
            },
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "That works.".to_string(),
            },
        ]);

        assert_eq!(
            rendered,
            "Me: I want the transcript labels.\n\nThem: Use source labels first.\n\nMe: That works."
        );
    }

    #[test]
    fn labeled_meeting_transcript_merges_adjacent_source_text_and_skips_empty() {
        let rendered = format_labeled_transcript_segments(&[
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: "First sentence.".to_string(),
            },
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::Microphone,
                text: " Second sentence. ".to_string(),
            },
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::SystemAudio,
                text: " ".to_string(),
            },
            LabeledTranscriptSegment {
                source: FullSystemTranscriptionSource::SystemAudio,
                text: "Remote audio.".to_string(),
            },
        ]);

        assert_eq!(
            rendered,
            "Me: First sentence. Second sentence.\n\nThem: Remote audio."
        );
    }

    #[test]
    fn live_summary_prompt_requests_only_supported_sections() {
        let prompt = build_live_summary_prompt(
            "Discussed launch timing and follow-up work.",
            Some("## Current gist\nEarlier notes.".to_string()),
        );

        assert!(prompt.contains("current_gist"));
        assert!(prompt.contains("key_points"));
        assert!(prompt.contains("details"));
        assert!(prompt.contains("Current gist, Key points"));
        assert!(prompt.contains("Do not include action items"));
        assert!(prompt.contains("more expanded than terse bullets"));
        assert!(!prompt.contains("\"action_items\""));
        assert!(!prompt.contains("\"timeline\""));
        assert!(!prompt.contains("Notable points"));
        assert!(!prompt.contains("Risks / blockers"));
        assert!(!prompt.contains("Open questions"));
    }

    #[test]
    fn meeting_summary_json_renders_to_expanded_key_points() {
        let raw = r#"{
          "current_gist": "The team discussed launch timing.",
          "key_points": [{
            "text": "Launch timing depends on summary quality.",
            "details": [
              "The team wants the notes to stay readable in the desktop app.",
              "Repeated points should be merged instead of duplicated."
            ]
          }]
        }"#;

        let state = parse_meeting_summary_state(raw).expect("valid summary json");
        let rendered = render_meeting_summary_markdown(&state);

        assert!(rendered.contains("## Current gist"));
        assert!(rendered.contains("## Key points"));
        assert!(rendered.contains("- Launch timing depends on summary quality."));
        assert!(rendered.contains("  - The team wants the notes to stay readable"));
        assert!(!rendered.contains("## Action items"));
        assert!(!rendered.contains("## Timeline"));
        assert!(!rendered.contains("## Notable points"));
    }

    #[test]
    fn invalid_live_summary_output_keeps_previous_summary() {
        let previous = "## Current gist\nThe existing summary should remain.";
        let normalized = normalize_live_summary_output("not json", Some(previous));

        assert_eq!(normalized, previous);
    }

    #[test]
    fn empty_structured_summary_is_rejected() {
        let raw = r#"{
          "current_gist": " ",
          "key_points": []
        }"#;

        assert!(parse_meeting_summary_state(raw).is_none());
    }

    #[test]
    fn meeting_summary_renderer_keeps_detail_only_points() {
        let rendered = render_meeting_summary_markdown(&MeetingSummaryState {
            current_gist: "Launch planning is underway.".to_string(),
            key_points: vec![SummaryPoint {
                text: "".to_string(),
                details: vec!["The summary needs to be easy to scan.".to_string()],
            }],
        });

        assert!(rendered.contains("  - The summary needs to be easy to scan."));
        assert!(!rendered.contains("## Action items"));
        assert!(!rendered.contains("## Timeline"));
    }

    #[test]
    fn observed_stale_microphone_levels_count_as_silent_audio() {
        let mut samples = vec![0.003402; 20_000];
        samples[100] = 0.030187;

        assert!(is_effectively_silent_audio(&samples));
        assert!(!is_effectively_silent_audio(&[
            0.0, 0.08, -0.07, 0.06, -0.05, 0.04
        ]));
    }

    #[test]
    fn observed_quiet_meeting_microphone_levels_are_not_silent_source_audio() {
        let mut samples = vec![0.003378; 20_000];
        samples[100] = 0.020873;

        assert!(is_effectively_silent_audio(&samples));
        assert!(!is_effectively_silent_full_system_source_audio(&samples));
    }

    #[test]
    fn microphone_refresh_only_applies_to_named_always_on_standard_recording() {
        let mut settings = get_default_settings();
        settings.always_on_microphone = true;
        settings.selected_microphone = Some("DJI MIC MINI".to_string());

        assert!(should_refresh_microphone_stream_after_suspected_no_input(
            &settings,
            TranscriptionCompletionMode::Standard
        ));

        assert!(!should_refresh_microphone_stream_after_suspected_no_input(
            &settings,
            TranscriptionCompletionMode::FullSystemOverlay
        ));

        settings.selected_microphone = None;
        assert!(!should_refresh_microphone_stream_after_suspected_no_input(
            &settings,
            TranscriptionCompletionMode::Standard
        ));
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
            "qwen/qwen3.6-27b".to_string(),
        ];

        assert_eq!(
            select_preferred_groq_model(&available_models).as_deref(),
            Some("qwen/qwen3.6-27b")
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

    #[test]
    fn post_process_response_prefers_uttr_output_tag() {
        let response = "<think>cleaning notes</think><uttr_output>Hello, world.</uttr_output>";

        assert_eq!(clean_post_process_response(response), "Hello, world.");
    }

    #[test]
    fn post_process_response_extracts_final_chat_template_channel() {
        let response = "<|start|>assistant<|channel|>analysis<|message|>Need clean text.<|end|><|start|>assistant<|channel|>final<|message|>Hello, world.<|end|>";

        assert_eq!(clean_post_process_response(response), "Hello, world.");
    }

    #[test]
    fn post_process_response_strips_think_blocks_and_final_label() {
        let response = "<think>I should fix punctuation.</think>\nFinal: Hello, world.";

        assert_eq!(clean_post_process_response(response), "Hello, world.");
    }

    #[test]
    fn empty_post_process_response_is_not_usable() {
        assert_eq!(usable_post_processed_text("   ".to_string()), None);
        assert_eq!(
            usable_post_processed_text("Hello, world.".to_string()).as_deref(),
            Some("Hello, world.")
        );
    }
}
