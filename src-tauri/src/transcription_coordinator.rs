use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use crate::managers::full_system_audio::FullSystemAudioSessionManager;
use crate::managers::transcription::TranscriptionManager;
use crate::{shortcut, utils};
use log::{debug, error, info, warn};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(30);
const PROCESSING_WATCHDOG: Duration = Duration::from_secs(20);
const SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE: Duration = Duration::from_millis(1500);
const SLOW_START_LOG_THRESHOLD: Duration = Duration::from_millis(500);

/// Commands processed sequentially by the coordinator thread.
#[derive(Clone)]
enum Command {
    Input {
        binding_id: String,
        hotkey_string: String,
        is_pressed: bool,
        push_to_talk: bool,
        received_at: Instant,
    },
    Cancel {
        recording_was_active: bool,
    },
    ProcessingFinished,
}

/// Pipeline lifecycle, owned exclusively by the coordinator thread.
enum Stage {
    Idle,
    Recording(String), // binding_id
    Processing,
}

#[derive(Default)]
struct PushToTalkSuppression {
    ignored_press_binding: Option<String>,
    suppress_until: Option<Instant>,
}

impl PushToTalkSuppression {
    fn note_ignored_processing_press(&mut self, binding_id: &str) {
        self.ignored_press_binding = Some(binding_id.to_string());
    }

    fn consume_release_after_ignored_press(&mut self, binding_id: &str, now: Instant) -> bool {
        if self.ignored_press_binding.as_deref() != Some(binding_id) {
            return false;
        }

        self.ignored_press_binding = None;
        self.suppress_until = Some(now + SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE);
        true
    }

    fn suppresses_press(&mut self, binding_id: &str, now: Instant) -> bool {
        match self.suppress_until {
            Some(until) if now <= until => {
                debug!(
                    "Suppressing push-to-talk press for '{}' after ignored processing press",
                    binding_id
                );
                true
            }
            Some(_) => {
                self.suppress_until = None;
                false
            }
            None => false,
        }
    }
}

/// Serialises all transcription lifecycle events through a single thread
/// to eliminate race conditions between keyboard shortcuts, signals, and
/// the async transcribe-paste pipeline.
pub struct TranscriptionCoordinator {
    app: AppHandle,
    tx: Mutex<Sender<Command>>,
}

pub fn is_transcribe_binding(id: &str) -> bool {
    id == "transcribe" || id == "transcribe_full_system_audio" || id == "edit_mode"
}

pub fn transcribe_binding_push_to_talk(id: &str, push_to_talk: bool) -> bool {
    push_to_talk && matches!(id, "transcribe" | "edit_mode")
}

pub fn transcription_session_is_active(
    audio_recording_active: bool,
    full_system_active: bool,
) -> bool {
    audio_recording_active || full_system_active
}

impl TranscriptionCoordinator {
    pub fn new(app: AppHandle) -> Self {
        let tx = Self::spawn_worker(app.clone());

        Self {
            app,
            tx: Mutex::new(tx),
        }
    }

    fn spawn_worker(app: AppHandle) -> Sender<Command> {
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            Self::run_worker(app, rx);
        });

        tx
    }

    fn run_worker(app: AppHandle, rx: Receiver<Command>) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut stage = Stage::Idle;
            let mut last_press: Option<Instant> = None;
            let mut processing_started_at: Option<Instant> = None;
            let mut push_to_talk_suppression = PushToTalkSuppression::default();

            while let Ok(cmd) = rx.recv() {
                match cmd {
                    Command::Input {
                        binding_id,
                        hotkey_string,
                        is_pressed,
                        push_to_talk,
                        received_at,
                    } => {
                        // Debounce rapid-fire press events (key repeat / double-tap).
                        // Releases always pass through for push-to-talk.
                        if is_pressed {
                            if last_press
                                .map(|t| received_at.saturating_duration_since(t) < DEBOUNCE)
                                .unwrap_or(false)
                            {
                                debug!("Debounced press for '{binding_id}'");
                                continue;
                            }
                            last_press = Some(received_at);

                            if matches!(stage, Stage::Processing)
                                && processing_started_at
                                    .map(|started| started.elapsed() > PROCESSING_WATCHDOG)
                                    .unwrap_or(false)
                            {
                                warn!(
                                    "Processing watchdog exceeded {:?}; resetting coordinator to idle",
                                    PROCESSING_WATCHDOG
                                );
                                stage = Stage::Idle;
                                processing_started_at = None;
                            }
                        }

                        let push_to_talk =
                            transcribe_binding_push_to_talk(&binding_id, push_to_talk);

                        if push_to_talk {
                            if is_pressed && matches!(stage, Stage::Idle) {
                                if push_to_talk_suppression
                                    .suppresses_press(&binding_id, Instant::now())
                                {
                                    continue;
                                }
                                start(&app, &mut stage, &binding_id, &hotkey_string);
                            } else if is_pressed
                                && matches!(&stage, Stage::Recording(id) if id == &binding_id)
                            {
                                warn!(
                                    "Received push-to-talk press while already recording '{}'; treating as stop",
                                    binding_id
                                );
                                stop(&app, &mut stage, &binding_id, &hotkey_string);
                                processing_started_at = Some(Instant::now());
                            } else if !is_pressed
                                && matches!(&stage, Stage::Recording(id) if id == &binding_id)
                            {
                                if release_predates_recording_start(&app, &binding_id, received_at)
                                {
                                    cancel_stale_push_to_talk_recording(
                                        &app,
                                        &mut stage,
                                        &binding_id,
                                    );
                                    processing_started_at = None;
                                } else {
                                    stop(&app, &mut stage, &binding_id, &hotkey_string);
                                    processing_started_at = Some(Instant::now());
                                }
                            } else if is_pressed && matches!(stage, Stage::Processing) {
                                debug!(
                                    "Ignoring push-to-talk press for '{}' while transcription is processing",
                                    binding_id
                                );
                                push_to_talk_suppression.note_ignored_processing_press(&binding_id);
                            } else if !is_pressed
                                && (matches!(stage, Stage::Idle)
                                    || matches!(stage, Stage::Processing))
                            {
                                if push_to_talk_suppression.consume_release_after_ignored_press(
                                    &binding_id,
                                    Instant::now(),
                                ) {
                                    debug!(
                                        "Consumed push-to-talk release for '{}' after ignored processing press",
                                        binding_id
                                    );
                                }
                            }
                        } else if is_pressed {
                            match &stage {
                                Stage::Idle => {
                                    start(&app, &mut stage, &binding_id, &hotkey_string);
                                }
                                Stage::Recording(id) if id == &binding_id => {
                                    stop(&app, &mut stage, &binding_id, &hotkey_string);
                                    processing_started_at = Some(Instant::now());
                                }
                                _ => debug!("Ignoring press for '{binding_id}': pipeline busy"),
                            }
                        }
                    }
                    Command::Cancel {
                        recording_was_active,
                    } => {
                        if recording_was_active
                            || matches!(stage, Stage::Recording(_))
                            || matches!(stage, Stage::Processing)
                        {
                            stage = Stage::Idle;
                            processing_started_at = None;
                        }
                    }
                    Command::ProcessingFinished => {
                        stage = Stage::Idle;
                        processing_started_at = None;
                    }
                }
            }
            debug!("Transcription coordinator exited");
        }));
        if let Err(e) = result {
            error!("Transcription coordinator panicked: {e:?}");
        }
    }

    fn send_with_recovery(&self, command: Command) {
        let retry_command = command.clone();
        let mut sender = self.tx.lock().unwrap();

        if sender.send(command).is_ok() {
            return;
        }

        warn!("Transcription coordinator channel closed; restarting worker");
        *sender = Self::spawn_worker(self.app.clone());

        if sender.send(retry_command).is_err() {
            warn!("Transcription coordinator restart failed");
        }
    }

    /// Send a keyboard/signal input event for a transcribe binding.
    /// For signal-based toggles, use `is_pressed: true` and `push_to_talk: false`.
    pub fn send_input(
        &self,
        binding_id: &str,
        hotkey_string: &str,
        is_pressed: bool,
        push_to_talk: bool,
    ) {
        self.send_with_recovery(Command::Input {
            binding_id: binding_id.to_string(),
            hotkey_string: hotkey_string.to_string(),
            is_pressed,
            push_to_talk,
            received_at: Instant::now(),
        });
    }

    pub fn notify_cancel(&self, recording_was_active: bool) {
        self.send_with_recovery(Command::Cancel {
            recording_was_active,
        });
    }

    pub fn notify_processing_finished(&self) {
        self.send_with_recovery(Command::ProcessingFinished);
    }
}

fn start(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let start_time = Instant::now();

    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.start(app, binding_id, hotkey_string);
    let audio_recording_active = app
        .try_state::<Arc<AudioRecordingManager>>()
        .map_or(false, |a| a.is_recording());
    let full_system_active = app
        .try_state::<Arc<FullSystemAudioSessionManager>>()
        .map_or(false, |a| a.is_active());

    if transcription_session_is_active(audio_recording_active, full_system_active) {
        *stage = Stage::Recording(binding_id.to_string());
        info!(
            "[latency] coordinator start active binding={} elapsed_ms={}",
            binding_id,
            start_time.elapsed().as_millis()
        );
    } else {
        debug!("Start for '{binding_id}' did not begin recording; staying idle");
        if start_time.elapsed() >= SLOW_START_LOG_THRESHOLD {
            warn!(
                "[latency] coordinator slow inactive start binding={} elapsed_ms={}",
                binding_id,
                start_time.elapsed().as_millis()
            );
        }
    }
}

fn release_predates_recording_start(
    app: &AppHandle,
    binding_id: &str,
    release_received_at: Instant,
) -> bool {
    release_received_before_recording_started(
        release_received_at,
        app.try_state::<Arc<AudioRecordingManager>>()
            .and_then(|manager| manager.current_recording_started_at(binding_id)),
    )
}

fn release_received_before_recording_started(
    release_received_at: Instant,
    recording_started_at: Option<Instant>,
) -> bool {
    recording_started_at
        .map(|started_at| release_received_at < started_at)
        .unwrap_or(false)
}

fn cancel_stale_push_to_talk_recording(app: &AppHandle, stage: &mut Stage, binding_id: &str) {
    warn!(
        "Discarding stale push-to-talk recording for '{}' because release arrived before audio became active",
        binding_id
    );

    shortcut::unregister_cancel_shortcut(app);

    if let Some(audio_manager) = app.try_state::<Arc<AudioRecordingManager>>() {
        audio_manager.cancel_recording();
    }
    if let Some(tm) = app.try_state::<Arc<TranscriptionManager>>() {
        tm.cancel_incremental_session();
    }

    utils::change_tray_icon(app, crate::tray::TrayIconState::Idle);
    utils::hide_recording_overlay(app);
    *stage = Stage::Idle;
}

fn stop(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let stop_time = Instant::now();
    info!("[latency] coordinator stop begin binding={}", binding_id);

    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.stop(app, binding_id, hotkey_string);
    *stage = Stage::Processing;
    info!(
        "[latency] coordinator stop dispatched binding={} elapsed_ms={}",
        binding_id,
        stop_time.elapsed().as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::{
        is_transcribe_binding, release_received_before_recording_started,
        transcribe_binding_push_to_talk, transcription_session_is_active, PushToTalkSuppression,
        SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn full_system_binding_routes_through_transcribe_coordinator() {
        assert!(is_transcribe_binding("transcribe_full_system_audio"));
    }

    #[test]
    fn edit_mode_binding_routes_through_transcribe_coordinator() {
        assert!(is_transcribe_binding("edit_mode"));
        assert!(transcribe_binding_push_to_talk("edit_mode", true));
        assert!(!transcribe_binding_push_to_talk("edit_mode", false));
    }

    #[test]
    fn full_system_binding_forces_toggle_mode() {
        assert!(!transcribe_binding_push_to_talk(
            "transcribe_full_system_audio",
            true
        ));
        assert!(!transcribe_binding_push_to_talk(
            "transcribe_full_system_audio",
            false
        ));
    }

    #[test]
    fn existing_transcribe_bindings_preserve_push_to_talk_setting() {
        assert!(transcribe_binding_push_to_talk("transcribe", true));
        assert!(!transcribe_binding_push_to_talk("transcribe", false));
    }

    #[test]
    fn post_process_shortcut_does_not_route_through_transcribe_coordinator() {
        assert!(!is_transcribe_binding("transcribe_with_post_process"));
        assert!(!transcribe_binding_push_to_talk(
            "transcribe_with_post_process",
            true
        ));
    }

    #[test]
    fn transcription_session_active_helper_treats_either_source_as_active() {
        assert!(transcription_session_is_active(true, false));
        assert!(transcription_session_is_active(false, true));
        assert!(transcription_session_is_active(true, true));
        assert!(!transcription_session_is_active(false, false));
    }

    #[test]
    fn ignored_processing_press_release_suppresses_immediate_next_press() {
        let mut suppression = PushToTalkSuppression::default();
        let now = Instant::now();

        suppression.note_ignored_processing_press("transcribe");

        assert!(suppression.consume_release_after_ignored_press("transcribe", now));
        assert!(suppression.suppresses_press("transcribe", now + Duration::from_millis(500)));
        assert!(!suppression.suppresses_press(
            "transcribe",
            now + SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE + Duration::from_millis(1)
        ));
    }

    #[test]
    fn ignored_processing_press_release_is_binding_scoped() {
        let mut suppression = PushToTalkSuppression::default();
        let now = Instant::now();

        suppression.note_ignored_processing_press("transcribe");

        assert!(
            !suppression.consume_release_after_ignored_press("transcribe_full_system_audio", now)
        );
        assert!(!suppression.suppresses_press("transcribe", now));
    }

    #[test]
    fn release_before_recording_start_is_stale_push_to_talk() {
        let release_received_at = Instant::now();
        let recording_started_at = release_received_at + Duration::from_millis(250);

        assert!(release_received_before_recording_started(
            release_received_at,
            Some(recording_started_at)
        ));
    }

    #[test]
    fn release_after_recording_start_is_normal_push_to_talk_stop() {
        let recording_started_at = Instant::now();
        let release_received_at = recording_started_at + Duration::from_millis(250);

        assert!(!release_received_before_recording_started(
            release_received_at,
            Some(recording_started_at)
        ));
    }

    #[test]
    fn missing_recording_start_is_not_stale_push_to_talk() {
        assert!(!release_received_before_recording_started(
            Instant::now(),
            None
        ));
    }
}
