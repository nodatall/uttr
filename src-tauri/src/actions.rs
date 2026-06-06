use crate::access::{
    bootstrap_install_state, get_install_access_snapshot, install_access_allows_premium_features,
    install_access_allows_transcription, premium_feature_access_message, refresh_entitlement_state,
};
use crate::app_context::{collect_text_context, AppContextSnapshot};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::byok_secrets;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::full_system_audio::{
    FullSystemAudioSessionManager, FullSystemSessionStopResult,
    FullSystemSessionTranscriptionSamples, FullSystemTranscriptionSource,
    FullSystemTranscriptionSourceSamples,
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
const FULL_SYSTEM_LIVE_SUMMARY_SECONDS: usize = 60;
const FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL: u64 =
    (FULL_SYSTEM_LIVE_SUMMARY_SECONDS / FULL_SYSTEM_LIVE_CHUNK_SECONDS) as u64;
const FULL_SYSTEM_SUMMARY_MODEL_FALLBACK: &str = "gpt-4o-mini";
const FULL_SYSTEM_SUMMARY_SYSTEM_PROMPT: &str = "You are the live meeting summarizer inside Uttr, a macOS transcription app. Update meeting notes from transcript text only. Return valid JSON only with current_gist and expanded key_points.";

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
    chunk_count: AtomicU64,
    transcript_text: Mutex<String>,
    summary_text: Mutex<Option<String>>,
    summary_provider: Mutex<Option<String>>,
    summary_error: Mutex<Option<String>>,
    summary_disabled: AtomicBool,
    recorded_samples: Mutex<Vec<f32>>,
    pending_samples: Mutex<Vec<f32>>,
    pending_microphone_samples: Mutex<Vec<f32>>,
    pending_system_audio_samples: Mutex<Vec<f32>>,
    last_transcript_source: Mutex<Option<FullSystemTranscriptionSource>>,
}

impl FullSystemLiveRuntime {
    fn new() -> Self {
        Self {
            stop_requested: AtomicBool::new(false),
            chunk_count: AtomicU64::new(0),
            transcript_text: Mutex::new(String::new()),
            summary_text: Mutex::new(None),
            summary_provider: Mutex::new(None),
            summary_error: Mutex::new(None),
            summary_disabled: AtomicBool::new(false),
            recorded_samples: Mutex::new(Vec::new()),
            pending_samples: Mutex::new(Vec::new()),
            pending_microphone_samples: Mutex::new(Vec::new()),
            pending_system_audio_samples: Mutex::new(Vec::new()),
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
}

static FULL_SYSTEM_LIVE_SESSION: Lazy<Mutex<Option<FullSystemLiveSession>>> =
    Lazy::new(|| Mutex::new(None));
static ACTIVE_APP_CONTEXT: Lazy<Mutex<HashMap<String, AppContextSnapshot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static ACTIVE_APP_CONTEXT_REQUESTS: Lazy<Mutex<HashMap<String, u64>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static APP_CONTEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static ASK_SELECTION_CHAT_SESSION: Lazy<Mutex<Option<AskSelectionChatSession>>> =
    Lazy::new(|| Mutex::new(None));
static ASK_SELECTION_CHAT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct AskSelectionChatSession {
    id: u64,
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
}

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
    completion_mode: TranscriptionCompletionMode,
}

struct FullSystemTranscribeAction {
    post_process: bool,
}

struct TogglePostProcessingAction;

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

const ASK_SELECTION_SYSTEM_PROMPT: &str = "You answer a spoken request using the user's selected text as context. Return only the answer. Do not replace, rewrite, or quote the selection unless the request asks for that. Do not explain your process, wrap in markdown fences, or include labels.";

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
    utils::AskSelectionPayload {
        state: state.to_string(),
        text,
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
    selected_text: Option<String>,
    context: AppContextSnapshot,
    messages: Vec<utils::AskSelectionMessage>,
) {
    if let Ok(mut session) = ASK_SELECTION_CHAT_SESSION.lock() {
        *session = Some(AskSelectionChatSession {
            id: session_id,
            selected_text,
            context,
            messages,
        });
    }
}

fn current_ask_selection_messages() -> Vec<utils::AskSelectionMessage> {
    ASK_SELECTION_CHAT_SESSION
        .lock()
        .ok()
        .and_then(|session| session.as_ref().map(|session| session.messages.clone()))
        .unwrap_or_default()
}

fn build_ask_selection_prompt(
    selected_text: &str,
    spoken_instruction: &str,
    context: &AppContextSnapshot,
    custom_vocabulary_terms: &[String],
) -> String {
    let mut prompt = format!(
        "# Task\nAnswer the spoken request using the selected text as context. Return only the answer inside <uttr_ask_output>...</uttr_ask_output>. Do not modify the user's selected text or produce replacement text unless the spoken request explicitly asks for a rewrite.\n\n# Spoken request\n{}\n\n# Selected text\n{}",
        spoken_instruction.trim(),
        selected_text
    );

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
    let mut prompt = format!(
        "# Task\nAnswer the latest follow-up using the selected text and prior Ask Selection chat as context. Return only the answer inside <uttr_ask_output>...</uttr_ask_output>. Do not invent facts outside the selected text unless the user asks a general question.\n\n# Latest follow-up\n{}\n\n# Selected text\n{}",
        follow_up.trim(),
        selected_text
    );

    if !conversation.trim().is_empty() {
        prompt.push_str("\n\n# Prior chat\n");
        prompt.push_str(&conversation);
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
    match summary_client::transform_with_codex_app(
        prompt.clone(),
        ASK_SELECTION_SYSTEM_PROMPT.to_string(),
    )
    .await
    {
        Ok(output) => {
            let output = clean_ask_selection_response(&output);
            if output.trim().is_empty() {
                return Err("Codex returned an empty Ask Selection answer.".to_string());
            }
            return Ok((output, "Ask Selection via Codex app-server".to_string()));
        }
        Err(error) => summary_client::summarize_codex_unavailable(&error),
    }

    let provider = settings
        .active_post_process_provider()
        .cloned()
        .ok_or_else(|| "Ask Selection fallback needs a post-processing provider.".to_string())?;

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
        .ok_or_else(|| {
            "Ask Selection fallback could not resolve a post-processing model.".to_string()
        })?;

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
    .ok_or_else(|| "Ask Selection fallback returned an empty answer.".to_string())
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
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Ask Selection selected text is no longer available.".to_string())?;

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
        Some(selected_text.clone()),
        session.context.clone(),
        pending_messages.clone(),
    );
    utils::update_ask_selection_panel(
        &app_handle,
        ask_selection_payload("thinking", Some(session.id), pending_messages, None, None),
    );

    let settings = get_settings(&app_handle);
    let prompt = build_ask_selection_follow_up_prompt(
        &selected_text,
        &session.messages,
        &follow_up,
        &session.context,
        &settings.custom_vocabulary_terms,
    );

    match run_ask_selection_prompt(&app_handle, &settings, prompt).await {
        Ok((answer, _prompt_label)) => {
            session
                .messages
                .push(ask_selection_message("assistant", answer.clone(), false));
            update_ask_selection_session(
                session.id,
                Some(selected_text),
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

async fn transcribe_and_summarize_live_chunk(
    app: &AppHandle,
    runtime: &Arc<FullSystemLiveRuntime>,
    tm: &Arc<TranscriptionManager>,
    chunk: FullSystemLiveChunk,
    is_final_chunk: bool,
    record_samples: bool,
) {
    if chunk.is_empty() {
        return;
    }

    if record_samples {
        runtime
            .recorded_samples
            .lock()
            .unwrap()
            .extend_from_slice(&chunk.mixed_samples);
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

    let transcription_segments =
        match transcribe_full_system_live_chunk_sources(tm, chunk, chunk_index).await {
            Ok(segments) => segments,
            Err(error) => {
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
                return;
            }
        };

    if !transcription_segments.is_empty() {
        let transcript_so_far = {
            let mut transcript = runtime.transcript_text.lock().unwrap();
            let mut last_source = runtime.last_transcript_source.lock().unwrap();
            for segment in &transcription_segments {
                append_labeled_live_text(
                    &mut transcript,
                    &mut *last_source,
                    segment.source,
                    &segment.text,
                );
            }
            transcript.clone()
        };

        let completed_chunk = runtime.chunk_count.fetch_add(1, Ordering::Relaxed) + 1;
        if !should_update_live_summary(completed_chunk, is_final_chunk) {
            if !runtime.stop_requested.load(Ordering::Relaxed) {
                emit_live_session_transcribed_state(
                    app,
                    completed_chunk,
                    runtime.summary_text.lock().unwrap().clone(),
                    runtime.summary_error.lock().unwrap().clone(),
                );
            }
            return;
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
            return;
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
        match summarize_live_session(app, &transcript_so_far, previous_summary, completed_chunk)
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
}

async fn transcribe_full_system_live_chunk_sources(
    tm: &Arc<TranscriptionManager>,
    chunk: FullSystemLiveChunk,
    chunk_index: u64,
) -> Result<Vec<LabeledTranscriptSegment>, anyhow::Error> {
    let mut segments = Vec::new();

    if chunk.source_samples.is_empty() {
        let transcription = tm
            .transcribe_with_source(chunk.mixed_samples, Some("full_system_audio"))
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
        if source_samples.samples.is_empty() || is_effectively_silent_audio(&source_samples.samples)
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
        let text = tm
            .transcribe_with_source(source_samples.samples, Some(source_id))
            .await?;
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

    Ok(segments)
}

fn start_full_system_live_session(app: &AppHandle, binding_id: &str) {
    let runtime = Arc::new(FullSystemLiveRuntime::new());
    let worker_runtime = Arc::clone(&runtime);
    let worker_app = app.clone();
    let worker_binding = binding_id.to_string();
    let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
    let full_system_audio = Arc::clone(&app.state::<Arc<FullSystemAudioSessionManager>>());

    let worker_handle = tauri::async_runtime::spawn(async move {
        let mut buffered = Vec::<f32>::new();
        let mut buffered_microphone = Vec::<f32>::new();
        let mut buffered_system_audio = Vec::<f32>::new();

        while !worker_runtime.stop_requested.load(Ordering::Relaxed) {
            if let Some(delta) = full_system_audio.drain_session_delta_sources(&worker_binding) {
                if let Some(mixed) = delta.mixed {
                    if !mixed.is_empty() {
                        buffered.extend_from_slice(&mixed);
                    }
                }
                for source_samples in delta.sources {
                    match source_samples.source {
                        FullSystemTranscriptionSource::Microphone => {
                            buffered_microphone.extend_from_slice(&source_samples.samples);
                        }
                        FullSystemTranscriptionSource::SystemAudio => {
                            buffered_system_audio.extend_from_slice(&source_samples.samples);
                        }
                    }
                }
            }

            while buffered.len() >= FULL_SYSTEM_LIVE_CHUNK_SAMPLES
                && !worker_runtime.stop_requested.load(Ordering::Relaxed)
            {
                let mixed_samples: Vec<f32> =
                    buffered.drain(..FULL_SYSTEM_LIVE_CHUNK_SAMPLES).collect();
                let microphone_samples =
                    drain_front_up_to(&mut buffered_microphone, FULL_SYSTEM_LIVE_CHUNK_SAMPLES);
                let system_audio_samples =
                    drain_front_up_to(&mut buffered_system_audio, FULL_SYSTEM_LIVE_CHUNK_SAMPLES);
                let chunk = FullSystemLiveChunk {
                    mixed_samples,
                    source_samples: source_samples_from_buffers(
                        microphone_samples,
                        system_audio_samples,
                    ),
                };
                transcribe_and_summarize_live_chunk(
                    &worker_app,
                    &worker_runtime,
                    &tm,
                    chunk,
                    false,
                    true,
                )
                .await;
            }

            sleep(FULL_SYSTEM_LIVE_CHUNK_POLL_INTERVAL).await;
        }

        if !buffered.is_empty() {
            worker_runtime
                .pending_samples
                .lock()
                .unwrap()
                .extend_from_slice(&buffered);
        }
        if !buffered_microphone.is_empty() {
            worker_runtime
                .pending_microphone_samples
                .lock()
                .unwrap()
                .extend_from_slice(&buffered_microphone);
        }
        if !buffered_system_audio.is_empty() {
            worker_runtime
                .pending_system_audio_samples
                .lock()
                .unwrap()
                .extend_from_slice(&buffered_system_audio);
        }
    });

    let mut guard = FULL_SYSTEM_LIVE_SESSION.lock().unwrap();
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
    if let Err(error) = session.worker_handle.await {
        warn!("Live full-system worker join error: {}", error);
    }

    let mut final_samples = {
        let mut pending = session.runtime.pending_samples.lock().unwrap();
        std::mem::take(&mut *pending)
    };
    let mut final_microphone_samples = {
        let mut pending = session.runtime.pending_microphone_samples.lock().unwrap();
        std::mem::take(&mut *pending)
    };
    let mut final_system_audio_samples = {
        let mut pending = session.runtime.pending_system_audio_samples.lock().unwrap();
        std::mem::take(&mut *pending)
    };
    if let Some(tail_samples) = tail_samples {
        if let Some(mixed) = tail_samples.mixed.filter(|samples| !samples.is_empty()) {
            final_samples.extend_from_slice(&mixed);
        }
        for source_samples in tail_samples.sources {
            match source_samples.source {
                FullSystemTranscriptionSource::Microphone => {
                    final_microphone_samples.extend_from_slice(&source_samples.samples);
                }
                FullSystemTranscriptionSource::SystemAudio => {
                    final_system_audio_samples.extend_from_slice(&source_samples.samples);
                }
            }
        }
    }
    if !final_samples.is_empty() {
        let final_chunk = FullSystemLiveChunk {
            mixed_samples: final_samples,
            source_samples: source_samples_from_buffers(
                final_microphone_samples,
                final_system_audio_samples,
            ),
        };
        transcribe_and_summarize_live_chunk(app, &session.runtime, &tm, final_chunk, true, true)
            .await;
    }

    let transcript_text = session.runtime.transcript_text.lock().unwrap().clone();
    let summary_text = session.runtime.summary_text.lock().unwrap().clone();
    let summary_provider = session.runtime.summary_provider.lock().unwrap().clone();
    let recorded_samples = session.runtime.recorded_samples.lock().unwrap().clone();
    let chunk_count = session.runtime.chunk_count.load(Ordering::Relaxed);

    if transcript_text.trim().is_empty() && recorded_samples.is_empty() {
        return None;
    }

    Some(FullSystemLiveFinal {
        transcript_text,
        summary_text,
        summary_provider,
        recorded_samples,
        chunk_count,
    })
}

fn handle_transcription_stop(
    app: &AppHandle,
    binding_id: &str,
    samples: Option<Vec<f32>>,
    recording_duration: Option<Duration>,
    post_process: bool,
    use_incremental: bool,
    completion_mode: TranscriptionCompletionMode,
    tm: Arc<TranscriptionManager>,
    hm: Arc<HistoryManager>,
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
            if completion_mode == TranscriptionCompletionMode::EditMode {
                let session_id = current_ask_selection_session_id();
                utils::show_ask_selection_panel(
                    &ah,
                    ask_selection_payload(
                        "error",
                        Some(session_id),
                        current_ask_selection_messages(),
                        None,
                        Some(
                            "No audio captured. Try holding the shortcut a bit longer.".to_string(),
                        ),
                    ),
                );
                change_tray_icon(&ah, TrayIconState::Idle);
                return;
            }
            if recording_duration >= NO_INPUT_OVERLAY_MIN_DURATION {
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
            if completion_mode == TranscriptionCompletionMode::EditMode {
                let session_id = current_ask_selection_session_id();
                utils::show_ask_selection_panel(
                    &ah,
                    ask_selection_payload(
                        "error",
                        Some(session_id),
                        current_ask_selection_messages(),
                        None,
                        Some(
                            "No audio captured. Try holding the shortcut a bit longer.".to_string(),
                        ),
                    ),
                );
                change_tray_icon(&ah, TrayIconState::Idle);
                return;
            }
            if recording_duration >= NO_INPUT_OVERLAY_MIN_DURATION {
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
                    if completion_mode == TranscriptionCompletionMode::EditMode {
                        let session_id = current_ask_selection_session_id();
                        utils::show_ask_selection_panel(
                            &ah,
                            ask_selection_payload(
                                "error",
                                Some(session_id),
                                current_ask_selection_messages(),
                                None,
                                Some("No speech detected. Try recording again.".to_string()),
                            ),
                        );
                        change_tray_icon(&ah, TrayIconState::Idle);
                        return;
                    }
                    refresh_microphone_stream_after_suspected_no_input(
                        &ah,
                        &binding_id,
                        completion_mode,
                    );
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

                        let Some(selected_text) = selected_text else {
                            let message =
                                "Ask Selection needs selected text before you start recording.";
                            warn!("{}", message);
                            let _ = ah.emit("transcription-error", message.to_string());
                            utils::show_ask_selection_panel(
                                &ah,
                                ask_selection_payload(
                                    "error",
                                    Some(session_id),
                                    Vec::new(),
                                    None,
                                    Some(message.to_string()),
                                ),
                            );
                            change_tray_icon(&ah, TrayIconState::Idle);
                            return;
                        };

                        let mut thinking_messages = vec![
                            ask_selection_message("user", transcription.clone(), false),
                            ask_selection_message("assistant", "Thinking...", true),
                        ];
                        update_ask_selection_session(
                            session_id,
                            Some(selected_text.clone()),
                            context_snapshot.clone(),
                            thinking_messages.clone(),
                        );
                        utils::show_ask_selection_panel(
                            &ah,
                            ask_selection_payload(
                                "thinking",
                                Some(session_id),
                                thinking_messages.clone(),
                                None,
                                None,
                            ),
                        );
                        match answer_ask_selection(
                            &ah,
                            &settings,
                            &selected_text,
                            &transcription,
                            &context_snapshot,
                        )
                        .await
                        {
                            Ok((answer_text, prompt_label)) => {
                                let hm_clone = Arc::clone(&hm);
                                let ah_for_history = ah.clone();
                                let transcription_for_history = transcription.clone();
                                let answer_for_history = answer_text.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Err(e) = hm_clone
                                        .save_transcription(
                                            samples_clone,
                                            transcription_for_history,
                                            Some(answer_for_history),
                                            Some(prompt_label),
                                            "dictation",
                                        )
                                        .await
                                    {
                                        error!("Failed to save Ask Selection transcription: {}", e);
                                        let _ = ah_for_history.emit(
                                            "transcription-error",
                                            format!(
                                                "Ask Selection succeeded, but saving history failed: {}",
                                                e
                                            ),
                                        );
                                    }
                                });

                                thinking_messages.pop();
                                thinking_messages.push(ask_selection_message(
                                    "assistant",
                                    answer_text.clone(),
                                    false,
                                ));
                                update_ask_selection_session(
                                    session_id,
                                    Some(selected_text),
                                    context_snapshot,
                                    thinking_messages.clone(),
                                );
                                utils::update_ask_selection_panel(
                                    &ah,
                                    ask_selection_payload(
                                        "result",
                                        Some(session_id),
                                        thinking_messages,
                                        Some(answer_text),
                                        None,
                                    ),
                                );
                                change_tray_icon(&ah, TrayIconState::Idle);
                            }
                            Err(error) => {
                                error!("Ask Selection failed: {}", error);
                                let error_messages = vec![ask_selection_message(
                                    "user",
                                    transcription.clone(),
                                    false,
                                )];
                                utils::update_ask_selection_panel(
                                    &ah,
                                    ask_selection_payload(
                                        "error",
                                        Some(session_id),
                                        error_messages,
                                        None,
                                        Some(error.clone()),
                                    ),
                                );
                                let _ = ah.emit("transcription-error", error);
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
                    let finalized = finalize_transcription_output(
                        &ah,
                        &settings,
                        &transcription,
                        post_process,
                        Some(&context_snapshot),
                    )
                    .await;
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
                        let hm_clone = Arc::clone(&hm);
                        let ah_for_history = ah.clone();
                        let transcription_for_history = transcription.clone();
                        tauri::async_runtime::spawn(async move {
                            match hm_clone
                                .save_transcription(
                                    samples_clone,
                                    transcription_for_history,
                                    post_processed_text,
                                    post_process_prompt,
                                    "dictation",
                                )
                                .await
                            {
                                Ok(history_entry_id) => {
                                    if release_smoke_enabled() {
                                        log::info!(
                                            "Release smoke history entry saved id={}",
                                            history_entry_id
                                        );
                                        let _ = ah_for_history.emit(
                                            "show-history-entry",
                                            serde_json::json!({
                                                "entryId": history_entry_id,
                                            }),
                                        );
                                    }
                                }
                                Err(e) => {
                                    error!("Failed to save transcription to history: {}", e);
                                }
                            }
                        });
                    }

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
                } else if completion_mode == TranscriptionCompletionMode::EditMode {
                    let session_id = current_ask_selection_session_id();
                    utils::show_ask_selection_panel(
                        &ah,
                        ask_selection_payload(
                            "error",
                            Some(session_id),
                            current_ask_selection_messages(),
                            None,
                            Some("No speech detected. Try recording again.".to_string()),
                        ),
                    );
                    change_tray_icon(&ah, TrayIconState::Idle);
                } else {
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                }
            }
            Err(err) => {
                if completion_mode == TranscriptionCompletionMode::EditMode {
                    let session_id = current_ask_selection_session_id();
                    let message = if suspected_no_input {
                        "No speech detected. Try recording again.".to_string()
                    } else {
                        format!("Ask Selection transcription failed: {}", err)
                    };
                    utils::show_ask_selection_panel(
                        &ah,
                        ask_selection_payload(
                            "error",
                            Some(session_id),
                            current_ask_selection_messages(),
                            None,
                            Some(message),
                        ),
                    );
                    change_tray_icon(&ah, TrayIconState::Idle);
                    return;
                }
                if suspected_no_input {
                    refresh_microphone_stream_after_suspected_no_input(
                        &ah,
                        &binding_id,
                        completion_mode,
                    );
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
        }
        if !is_edit_mode && (self.post_process || settings.post_process_enabled) {
            store_active_context_async(&binding_id);
        }
        let use_incremental = should_use_incremental_transcription(&settings, &tm);

        let binding_id = binding_id.to_string();
        let rm = app.state::<Arc<AudioRecordingManager>>();

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

            recording_started = rm.try_start_recording(&binding_id);
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
            if rm.try_start_recording(&binding_id) {
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

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

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
        change_tray_icon(app, TrayIconState::Transcribing);
        if !is_edit_mode {
            spawn_deferred_overlay_state(app, DeferredOverlayState::Transcribing);
        }
        if use_incremental {
            tm.signal_incremental_stop(binding_id);
        }
        let recording_duration = rm.current_recording_duration(binding_id);
        let samples = rm.stop_recording(binding_id);
        log::info!(
            "[latency] transcribe samples retrieved binding={} sample_count={} elapsed_ms={}",
            binding_id,
            samples.as_ref().map(|samples| samples.len()).unwrap_or(0),
            stop_time.elapsed().as_millis()
        );
        if is_edit_mode && samples.as_ref().is_some_and(|samples| !samples.is_empty()) {
            utils::show_ask_selection_panel(
                app,
                ask_selection_payload("thinking", None, Vec::new(), None, None),
            );
            log::info!(
                "[latency] ask selection thinking panel requested after recording stop binding={} elapsed_ms={}",
                binding_id,
                stop_time.elapsed().as_millis()
            );
        }
        handle_transcription_stop(
            app,
            binding_id,
            samples,
            recording_duration,
            post_process,
            use_incremental,
            self.completion_mode,
            tm,
            hm,
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

        let tm = app.state::<Arc<TranscriptionManager>>();
        tm.clear_cancel_request();
        let settings = get_settings(app);
        tm.cancel_incremental_session();
        let binding_id = binding_id.to_string();
        let full_system_audio = app.state::<Arc<FullSystemAudioSessionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        let is_always_on = settings.always_on_microphone;
        let should_show_warming = !is_always_on && !rm.is_microphone_open();
        debug!("Full-system mode - always_on: {}", is_always_on);

        change_tray_icon(app, TrayIconState::Recording);

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
            log::info!(
                "[latency] full-system recording active binding={} recording_started={} elapsed_ms={}",
                binding_id,
                recording_started,
                start_time.elapsed().as_millis()
            );
            if recording_started {
                focus_workspace_window(app);
                emit_active_session_window_state(app);
                start_full_system_live_session(app, &binding_id);
                show_recording_overlay(app);
                log::info!(
                    "[latency] full-system overlay requested binding={} warming=false elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
            }
        } else {
            if should_show_warming {
                show_warming_overlay(app);
                log::info!(
                    "[latency] full-system overlay requested binding={} warming=true elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
            }
            let recording_start_time = Instant::now();
            if full_system_audio
                .start_session(&binding_id, start_config)
                .started
            {
                recording_started = true;
                focus_workspace_window(app);
                emit_active_session_window_state(app);
                start_full_system_live_session(app, &binding_id);
                show_recording_overlay(app);
                log::info!(
                    "[latency] full-system overlay requested binding={} warming=false elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
                log::info!(
                    "[latency] full-system recording active binding={} elapsed_ms={}",
                    binding_id,
                    start_time.elapsed().as_millis()
                );
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
        if !recording_started {
            emit_idle_session_window_state(app);
        }
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

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        shortcut::unregister_cancel_shortcut(app);

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

        change_tray_icon(app, TrayIconState::Transcribing);
        utils::hide_recording_overlay(app);
        emit_session_window_state(
            app,
            session_window_state_payload(FullSystemProgressStage::Preparing, None, None, None),
        );
        rm.remove_mute();
        play_feedback_sound(app, SoundType::Stop);

        signal_full_system_live_session_stop(binding_id);
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
            let _finish_guard = FinishGuard(live_app.clone());
            let mut ui_guard = UiResetGuard::new(live_app.clone());
            if let Some(live_final) = finish_full_system_live_session(
                &live_app,
                &live_binding_id,
                live_tail_samples,
                Arc::clone(&live_tm),
            )
            .await
            {
                if live_final.transcript_text.trim().is_empty() {
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

                match live_hm
                    .save_transcription(
                        live_final.recorded_samples,
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
                {
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
                fallback_samples,
                None,
                post_process,
                false,
                TranscriptionCompletionMode::FullSystemOverlay,
                live_tm,
                live_hm,
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

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
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
        ask_selection_message, build_ask_selection_follow_up_prompt, build_ask_selection_prompt,
        build_live_summary_prompt, clean_ask_selection_response, clean_post_process_response,
        clear_ask_selection_session, current_ask_selection_messages,
        current_ask_selection_session_id, custom_vocabulary_prompt_block,
        format_labeled_transcript_segments, friendly_live_summary_error,
        is_effectively_silent_audio, is_supported_post_process_model,
        normalize_live_summary_output, parse_meeting_summary_state,
        render_meeting_summary_markdown, resolved_post_process_system_prompt,
        select_preferred_groq_model, should_pause_live_summaries,
        should_refresh_microphone_stream_after_suspected_no_input, should_update_live_summary,
        toggle_post_process_enabled, transcription_timeout_for_samples,
        transcription_watchdog_delay, update_ask_selection_session, usable_post_processed_text,
        LabeledTranscriptSegment, MeetingSummaryState, SummaryPoint, TranscriptionCompletionMode,
        ACTION_MAP, FULL_PASS_TRANSCRIPTION_BASE_TIMEOUT, FULL_SYSTEM_LIVE_SUMMARY_CHUNK_INTERVAL,
    };
    use crate::app_context::AppContextSnapshot;
    use crate::managers::full_system_audio::FullSystemTranscriptionSource;
    use crate::settings::get_default_settings;

    #[test]
    fn full_system_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("transcribe_full_system_audio"));
    }

    #[test]
    fn copy_last_transcript_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("copy_last_transcript"));
    }

    #[test]
    fn post_process_shortcut_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("transcribe_with_post_process"));
    }

    #[test]
    fn edit_mode_binding_is_registered_in_action_map() {
        assert!(ACTION_MAP.contains_key("edit_mode"));
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
        assert!(prompt.contains("# Selected text\nCounselor overload"));
        assert!(prompt.contains("User: What is the risk?"));
        assert!(prompt.contains("Assistant: The buyer is unclear."));
        assert!(!prompt.contains("Thinking..."));
        assert!(prompt.contains("Google Docs"));
        assert!(prompt.contains("FreeFlow"));
        assert!(prompt.contains("<uttr_ask_output>"));
    }

    #[test]
    fn clear_ask_selection_session_drops_prior_messages() {
        let session_id = current_ask_selection_session_id();
        update_ask_selection_session(
            session_id,
            Some("selected text".to_string()),
            AppContextSnapshot::default(),
            vec![ask_selection_message("assistant", "Previous answer", false)],
        );

        assert_eq!(current_ask_selection_messages().len(), 1);

        clear_ask_selection_session();

        assert!(current_ask_selection_messages().is_empty());
        assert_ne!(current_ask_selection_session_id(), session_id);
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
