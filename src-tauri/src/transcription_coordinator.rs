use crate::actions::{promote_active_transcription_to_edit_mode, ACTION_MAP};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::full_system_audio::FullSystemAudioSessionManager;
use crate::managers::transcription::TranscriptionManager;
use crate::{shortcut, utils};
use log::{debug, error, info, warn};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(30);
const PROCESSING_WATCHDOG: Duration = Duration::from_secs(20);
const SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE: Duration = Duration::from_millis(1500);
const SLOW_START_LOG_THRESHOLD: Duration = Duration::from_millis(500);
static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

pub type OperationId = u64;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Operation {
    binding_id: String,
    id: OperationId,
}

impl Operation {
    fn new(binding_id: &str) -> Self {
        Self {
            binding_id: binding_id.to_string(),
            id: next_operation_id(),
        }
    }

    #[cfg(test)]
    fn with_id(binding_id: &str, id: OperationId) -> Self {
        Self {
            binding_id: binding_id.to_string(),
            id,
        }
    }

    fn matches(&self, binding_id: &str, operation_id: OperationId) -> bool {
        self.binding_id == binding_id && self.id == operation_id
    }
}

fn next_operation_id() -> OperationId {
    NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed)
}

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
    StopMeeting,
    UserCancel,
    CancelFinished,
    ProcessingFinished {
        binding_id: String,
        operation_id: OperationId,
    },
}

/// Pipeline lifecycle, owned exclusively by the coordinator thread.
#[derive(Clone, Debug, PartialEq, Eq)]
enum QuickDictationStage {
    Recording(Operation),
    Processing(Operation),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuickDictationInputAction {
    Start,
    Stop,
    Ignore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MeetingStopAction {
    StopMeeting,
    StopQuickThenMeeting,
    StopMeetingAndWaitForQuick,
    Ignore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserCancelAction {
    CancelStandalone,
    CancelQuickRecording,
    CancelQuickProcessing,
    CancelPendingQuickProcessing,
    CancelStoppingDictationRecording,
    CancelStoppingDictationProcessing,
    Ignore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ProcessingFinishedAction {
    None,
    DispatchMeetingStop(Operation),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ControlEffect {
    DispatchMeetingStop(Operation),
    StopTrackedDictation(Operation),
    CancelStandalone(Option<OperationId>),
    CancelQuickRecording {
        meeting: Operation,
        quick: Operation,
    },
    CancelQuickProcessing(Operation),
    CancelStoppingDictationRecording(Operation),
    CancelStoppingDictationProcessing(Operation),
    ClearQuickUi(OperationId),
    IgnoreCancel,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Stage {
    Idle,
    Recording(Operation),
    MeetingRecording {
        meeting: Operation,
        quick_dictation: Option<QuickDictationStage>,
    },
    MeetingStopPendingQuick {
        meeting: Operation,
        quick_processing: Operation,
    },
    MeetingStopping {
        meeting: Operation,
        dictation: Option<QuickDictationStage>,
        meeting_finished: bool,
    },
    Processing(Operation),
}

fn stage_label(stage: &Stage) -> String {
    match stage {
        Stage::Idle => "Idle".to_string(),
        Stage::Recording(operation) => {
            format!("Recording({}:{})", operation.binding_id, operation.id)
        }
        Stage::MeetingRecording {
            meeting,
            quick_dictation,
        } => match quick_dictation {
            Some(QuickDictationStage::Recording(quick)) => {
                format!(
                    "MeetingRecording({}:{}, quick=Recording({}:{}))",
                    meeting.binding_id, meeting.id, quick.binding_id, quick.id
                )
            }
            Some(QuickDictationStage::Processing(quick)) => {
                format!(
                    "MeetingRecording({}:{}, quick=Processing({}:{}))",
                    meeting.binding_id, meeting.id, quick.binding_id, quick.id
                )
            }
            None => format!("MeetingRecording({}:{})", meeting.binding_id, meeting.id),
        },
        Stage::MeetingStopPendingQuick {
            meeting,
            quick_processing,
        } => format!(
            "MeetingStopPendingQuick({}:{}, quick={}:{})",
            meeting.binding_id, meeting.id, quick_processing.binding_id, quick_processing.id
        ),
        Stage::MeetingStopping {
            meeting,
            dictation,
            meeting_finished,
        } => format!(
            "MeetingStopping({}:{}, dictation={dictation:?}, meeting_finished={meeting_finished})",
            meeting.binding_id, meeting.id
        ),
        Stage::Processing(operation) => {
            format!("Processing({}:{})", operation.binding_id, operation.id)
        }
    }
}

fn processing_watchdog_can_reset(stage: &Stage) -> bool {
    matches!(
        stage,
        Stage::Processing(operation)
            if operation.binding_id != "transcribe_full_system_audio"
    )
}

fn meeting_stop_action(stage: &Stage) -> MeetingStopAction {
    match stage {
        Stage::MeetingRecording {
            quick_dictation: None,
            ..
        } => MeetingStopAction::StopMeeting,
        Stage::MeetingRecording {
            quick_dictation: Some(QuickDictationStage::Recording(_)),
            ..
        } => MeetingStopAction::StopQuickThenMeeting,
        Stage::MeetingRecording {
            quick_dictation: Some(QuickDictationStage::Processing(_)),
            ..
        } => MeetingStopAction::StopMeetingAndWaitForQuick,
        _ => MeetingStopAction::Ignore,
    }
}

fn user_cancel_action(stage: &Stage) -> UserCancelAction {
    match stage {
        Stage::Recording(_) => UserCancelAction::CancelStandalone,
        Stage::Processing(operation) if operation.binding_id != "transcribe_full_system_audio" => {
            UserCancelAction::CancelStandalone
        }
        Stage::MeetingRecording {
            quick_dictation: Some(QuickDictationStage::Recording(_)),
            ..
        } => UserCancelAction::CancelQuickRecording,
        Stage::MeetingRecording {
            quick_dictation: Some(QuickDictationStage::Processing(_)),
            ..
        } => UserCancelAction::CancelQuickProcessing,
        Stage::MeetingStopPendingQuick { .. } => UserCancelAction::CancelPendingQuickProcessing,
        Stage::MeetingStopping {
            dictation: Some(QuickDictationStage::Recording(_)),
            ..
        } => UserCancelAction::CancelStoppingDictationRecording,
        Stage::MeetingStopping {
            dictation: Some(QuickDictationStage::Processing(_)),
            ..
        } => UserCancelAction::CancelStoppingDictationProcessing,
        Stage::Idle
        | Stage::Processing(_)
        | Stage::MeetingRecording {
            quick_dictation: None,
            ..
        }
        | Stage::MeetingStopping {
            dictation: None, ..
        } => UserCancelAction::Ignore,
    }
}

fn is_repeated_meeting_input(stage: &Stage, binding_id: &str) -> bool {
    match stage {
        Stage::MeetingRecording { meeting, .. } | Stage::MeetingStopping { meeting, .. } => {
            meeting.binding_id == binding_id
        }
        Stage::Processing(operation) => {
            operation.binding_id == "transcribe_full_system_audio"
                && operation.binding_id == binding_id
        }
        _ => false,
    }
}

fn can_start_dictation_while_legacy_meeting_processing(stage: &Stage, binding_id: &str) -> bool {
    binding_id == "transcribe"
        && matches!(
            stage,
            Stage::Processing(Operation { binding_id: active_binding, .. })
                if active_binding == "transcribe_full_system_audio"
        )
}

fn cancel_shortcut_should_be_registered(stage: &Stage) -> bool {
    match stage {
        Stage::Recording(operation) | Stage::Processing(operation) => {
            operation.binding_id != "transcribe_full_system_audio"
        }
        Stage::MeetingRecording {
            quick_dictation: Some(_),
            ..
        }
        | Stage::MeetingStopPendingQuick { .. }
        | Stage::MeetingStopping {
            dictation: Some(_), ..
        } => true,
        Stage::Idle
        | Stage::MeetingRecording {
            quick_dictation: None,
            ..
        }
        | Stage::MeetingStopping {
            dictation: None, ..
        } => false,
    }
}

fn sync_cancel_shortcut(app: &AppHandle, stage: &Stage) {
    if cancel_shortcut_should_be_registered(stage) {
        shortcut::register_cancel_shortcut(app);
    } else {
        shortcut::unregister_cancel_shortcut(app);
    }
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
            let mut last_press: Option<(String, Instant)> = None;
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
                        warn!(
                            "[ask-hotkey] coordinator_input binding={} pressed={} push_to_talk={} stage={}",
                            binding_id,
                            is_pressed,
                            push_to_talk,
                            stage_label(&stage)
                        );
                        // Debounce rapid-fire press events (key repeat / double-tap).
                        // Releases always pass through for push-to-talk.
                        if is_pressed {
                            if should_debounce_press(&last_press, &binding_id, received_at) {
                                debug!("Debounced press for '{binding_id}'");
                                continue;
                            }
                            last_press = Some((binding_id.clone(), received_at));

                            if processing_watchdog_can_reset(&stage)
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
                                sync_cancel_shortcut(&app, &stage);
                            }
                        }

                        let push_to_talk =
                            transcribe_binding_push_to_talk(&binding_id, push_to_talk);

                        if handle_meeting_quick_dictation_input(
                            &app,
                            &mut stage,
                            &binding_id,
                            &hotkey_string,
                            push_to_talk,
                            is_pressed,
                        ) {
                            continue;
                        }

                        if push_to_talk {
                            if is_pressed && matches!(stage, Stage::Idle) {
                                if push_to_talk_suppression
                                    .suppresses_press(&binding_id, Instant::now())
                                {
                                    continue;
                                }
                                start(&app, &mut stage, &binding_id, &hotkey_string);
                            } else if is_pressed
                                && can_start_dictation_while_legacy_meeting_processing(
                                    &stage,
                                    &binding_id,
                                )
                            {
                                if push_to_talk_suppression
                                    .suppresses_press(&binding_id, Instant::now())
                                {
                                    continue;
                                }
                                start_legacy_meeting_processing_dictation(
                                    &app,
                                    &mut stage,
                                    &binding_id,
                                    &hotkey_string,
                                );
                            } else if is_pressed
                                && matches!(&stage, Stage::Recording(operation)
                                    if operation.binding_id == binding_id)
                            {
                                warn!(
                                    "Received push-to-talk press while already recording '{}'; treating as stop",
                                    binding_id
                                );
                                stop(&app, &mut stage, &binding_id, &hotkey_string);
                                processing_started_at = Some(Instant::now());
                            } else if is_pressed
                                && matches!(&stage, Stage::Recording(operation)
                                    if binding_id == "edit_mode"
                                        && operation.binding_id == "transcribe")
                            {
                                let Stage::Recording(operation) = &stage else {
                                    unreachable!();
                                };
                                let from_binding_id = operation.binding_id.clone();
                                let operation_id = operation.id;
                                if promote_active_transcription_to_edit_mode(
                                    &app,
                                    &from_binding_id,
                                    &binding_id,
                                ) {
                                    info!(
                                        "Promoted push-to-talk recording from '{}' to '{}'",
                                        from_binding_id, binding_id
                                    );
                                    stage = Stage::Recording(Operation {
                                        binding_id: binding_id.clone(),
                                        id: operation_id,
                                    });
                                } else {
                                    warn!(
                                        "[ask-hotkey] promotion_failed from={} to={} stage={}",
                                        from_binding_id,
                                        binding_id,
                                        stage_label(&stage)
                                    );
                                }
                            } else if !is_pressed
                                && matches!(&stage, Stage::Recording(operation)
                                    if operation.binding_id == binding_id)
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
                            } else if is_pressed && matches!(stage, Stage::Processing(_)) {
                                debug!(
                                    "Ignoring push-to-talk press for '{}' while transcription is processing",
                                    binding_id
                                );
                                push_to_talk_suppression.note_ignored_processing_press(&binding_id);
                            } else if !is_pressed
                                && (matches!(stage, Stage::Idle)
                                    || matches!(stage, Stage::Processing(_)))
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
                                _ if can_start_dictation_while_legacy_meeting_processing(
                                    &stage,
                                    &binding_id,
                                ) =>
                                {
                                    start_legacy_meeting_processing_dictation(
                                        &app,
                                        &mut stage,
                                        &binding_id,
                                        &hotkey_string,
                                    );
                                }
                                Stage::Recording(operation)
                                    if operation.binding_id == binding_id =>
                                {
                                    stop(&app, &mut stage, &binding_id, &hotkey_string);
                                    processing_started_at = Some(Instant::now());
                                }
                                _ if is_repeated_meeting_input(&stage, &binding_id) => {
                                    debug!(
                                        "Ignoring repeated meeting shortcut '{}'; use the Stop button",
                                        binding_id
                                    );
                                }
                                _ => debug!("Ignoring press for '{binding_id}': pipeline busy"),
                            }
                        }
                    }
                    Command::StopMeeting => {
                        handle_meeting_stop(&app, &mut stage);
                        sync_cancel_shortcut(&app, &stage);
                        if matches!(stage, Stage::MeetingStopping { .. }) {
                            processing_started_at = Some(Instant::now());
                        }
                    }
                    Command::UserCancel => {
                        handle_user_cancel(&app, &mut stage);
                        sync_cancel_shortcut(&app, &stage);
                        if matches!(stage, Stage::Idle) {
                            processing_started_at = None;
                            last_press = None;
                        }
                    }
                    Command::CancelFinished => {
                        let effects = apply_control_command(&mut stage, &Command::CancelFinished);
                        execute_control_effects(&app, effects);
                        sync_cancel_shortcut(&app, &stage);
                        if matches!(stage, Stage::Idle) {
                            processing_started_at = None;
                            last_press = None;
                        }
                    }
                    Command::ProcessingFinished {
                        binding_id,
                        operation_id,
                    } => {
                        let command = Command::ProcessingFinished {
                            binding_id,
                            operation_id,
                        };
                        let effects = apply_control_command(&mut stage, &command);
                        execute_control_effects(&app, effects);
                        sync_cancel_shortcut(&app, &stage);
                        if matches!(stage, Stage::Idle) {
                            processing_started_at = None;
                        }
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

    pub fn request_meeting_stop(&self) {
        self.send_with_recovery(Command::StopMeeting);
    }

    pub fn request_user_cancel(&self) {
        self.send_with_recovery(Command::UserCancel);
    }

    pub fn notify_cancel_finished(&self) {
        self.send_with_recovery(Command::CancelFinished);
    }

    pub fn notify_processing_finished(&self, binding_id: &str, operation_id: OperationId) {
        self.send_with_recovery(Command::ProcessingFinished {
            binding_id: binding_id.to_string(),
            operation_id,
        });
    }
}

fn handle_meeting_stop(app: &AppHandle, stage: &mut Stage) {
    let effects = apply_control_command(stage, &Command::StopMeeting);
    execute_control_effects(app, effects);
}

fn apply_control_command(stage: &mut Stage, command: &Command) -> Vec<ControlEffect> {
    match command {
        Command::StopMeeting => apply_meeting_stop_command(stage),
        Command::UserCancel => apply_user_cancel_command(stage),
        Command::CancelFinished => {
            if matches!(stage, Stage::Recording(_))
                || matches!(
                    stage,
                    Stage::Processing(operation)
                        if operation.binding_id != "transcribe_full_system_audio"
                )
            {
                *stage = Stage::Idle;
            }
            Vec::new()
        }
        Command::ProcessingFinished {
            binding_id,
            operation_id,
        } => {
            let mut effects = vec![ControlEffect::ClearQuickUi(*operation_id)];
            if let ProcessingFinishedAction::DispatchMeetingStop(meeting) =
                finish_processing_stage(stage, binding_id, *operation_id)
            {
                effects.push(ControlEffect::DispatchMeetingStop(meeting));
            }
            effects
        }
        Command::Input { .. } => Vec::new(),
    }
}

fn apply_meeting_stop_command(stage: &mut Stage) -> Vec<ControlEffect> {
    let action = meeting_stop_action(stage);
    let Stage::MeetingRecording {
        meeting,
        quick_dictation,
    } = stage
    else {
        debug!(
            "Ignoring duplicate meeting Stop while stage={}",
            stage_label(stage)
        );
        return Vec::new();
    };
    let meeting = meeting.clone();

    match action {
        MeetingStopAction::StopMeeting => {
            transition_to_meeting_stopping(stage, &meeting, None);
            vec![ControlEffect::DispatchMeetingStop(meeting)]
        }
        MeetingStopAction::StopQuickThenMeeting => {
            let quick = match quick_dictation.as_ref() {
                Some(QuickDictationStage::Recording(operation)) => operation.clone(),
                _ => return Vec::new(),
            };
            defer_meeting_stop_until_quick_finishes(stage, meeting, quick.clone());
            vec![ControlEffect::StopTrackedDictation(quick)]
        }
        MeetingStopAction::StopMeetingAndWaitForQuick => {
            let quick = match quick_dictation.as_ref() {
                Some(QuickDictationStage::Processing(operation)) => operation.clone(),
                _ => return Vec::new(),
            };
            defer_meeting_stop_until_quick_finishes(stage, meeting, quick);
            Vec::new()
        }
        MeetingStopAction::Ignore => Vec::new(),
    }
}

fn defer_meeting_stop_until_quick_finishes(
    stage: &mut Stage,
    meeting: Operation,
    quick_processing: Operation,
) {
    *stage = Stage::MeetingStopPendingQuick {
        meeting,
        quick_processing,
    };
}

fn begin_meeting_stop_after_pending_quick_cancel(
    stage: &mut Stage,
) -> Option<(Operation, Operation)> {
    let Stage::MeetingStopPendingQuick {
        meeting,
        quick_processing,
    } = stage
    else {
        return None;
    };
    let meeting = meeting.clone();
    let quick_processing = quick_processing.clone();
    *stage = Stage::MeetingStopping {
        meeting: meeting.clone(),
        dictation: Some(QuickDictationStage::Processing(quick_processing.clone())),
        meeting_finished: false,
    };
    Some((meeting, quick_processing))
}

fn begin_quick_processing_cancel(stage: &mut Stage) -> Option<Operation> {
    let Stage::MeetingRecording {
        quick_dictation: Some(QuickDictationStage::Processing(operation)),
        ..
    } = stage
    else {
        return None;
    };
    let operation = operation.clone();
    if let Stage::MeetingRecording {
        quick_dictation, ..
    } = stage
    {
        *quick_dictation = None;
    }
    Some(operation)
}

fn handle_user_cancel(app: &AppHandle, stage: &mut Stage) {
    let effects = apply_control_command(stage, &Command::UserCancel);
    execute_control_effects(app, effects);
}

fn apply_user_cancel_command(stage: &mut Stage) -> Vec<ControlEffect> {
    match user_cancel_action(stage) {
        UserCancelAction::CancelStandalone => {
            let operation_id = match stage {
                Stage::Processing(operation) => Some(operation.id),
                _ => None,
            };
            *stage = Stage::Idle;
            vec![ControlEffect::CancelStandalone(operation_id)]
        }
        UserCancelAction::CancelQuickRecording => {
            let Stage::MeetingRecording {
                meeting,
                quick_dictation: Some(QuickDictationStage::Recording(quick)),
            } = stage
            else {
                return Vec::new();
            };
            let meeting = meeting.clone();
            let quick = quick.clone();
            *stage = Stage::MeetingRecording {
                meeting: meeting.clone(),
                quick_dictation: None,
            };
            vec![ControlEffect::CancelQuickRecording { meeting, quick }]
        }
        UserCancelAction::CancelQuickProcessing => {
            let Some(operation) = begin_quick_processing_cancel(stage) else {
                return Vec::new();
            };
            vec![ControlEffect::CancelQuickProcessing(operation)]
        }
        UserCancelAction::CancelPendingQuickProcessing => {
            let Some((meeting, quick_processing)) =
                begin_meeting_stop_after_pending_quick_cancel(stage)
            else {
                return Vec::new();
            };
            vec![
                ControlEffect::CancelQuickProcessing(quick_processing),
                ControlEffect::DispatchMeetingStop(meeting),
            ]
        }
        UserCancelAction::CancelStoppingDictationRecording => {
            let Stage::MeetingStopping {
                meeting,
                dictation: Some(QuickDictationStage::Recording(dictation)),
                meeting_finished,
            } = stage
            else {
                return Vec::new();
            };
            let meeting = meeting.clone();
            let dictation = dictation.clone();
            let meeting_finished = *meeting_finished;
            *stage = if meeting_finished {
                Stage::Idle
            } else {
                Stage::MeetingStopping {
                    meeting,
                    dictation: None,
                    meeting_finished: false,
                }
            };
            vec![ControlEffect::CancelStoppingDictationRecording(dictation)]
        }
        UserCancelAction::CancelStoppingDictationProcessing => {
            let Stage::MeetingStopping {
                meeting,
                dictation: Some(QuickDictationStage::Processing(dictation)),
                meeting_finished,
            } = stage
            else {
                return Vec::new();
            };
            let meeting = meeting.clone();
            let dictation = dictation.clone();
            let meeting_finished = *meeting_finished;
            *stage = if meeting_finished {
                Stage::Idle
            } else {
                Stage::MeetingStopping {
                    meeting,
                    dictation: None,
                    meeting_finished: false,
                }
            };
            vec![ControlEffect::CancelStoppingDictationProcessing(dictation)]
        }
        UserCancelAction::Ignore => {
            vec![ControlEffect::IgnoreCancel]
        }
    }
}

fn execute_control_effects(app: &AppHandle, effects: Vec<ControlEffect>) {
    for effect in effects {
        match effect {
            ControlEffect::DispatchMeetingStop(meeting) => {
                let stop_time = Instant::now();
                info!(
                    "[latency] coordinator stop begin binding={}",
                    meeting.binding_id
                );
                dispatch_meeting_stop(app, &meeting);
                info!(
                    "[latency] coordinator meeting stop dispatched binding={} elapsed_ms={}",
                    meeting.binding_id,
                    stop_time.elapsed().as_millis()
                );
            }
            ControlEffect::StopTrackedDictation(operation) => {
                let Some(action) = ACTION_MAP.get(&operation.binding_id) else {
                    warn!("No action in ACTION_MAP for '{}'", operation.binding_id);
                    continue;
                };
                action.stop(app, &operation.binding_id, "Meeting Stop", operation.id);
            }
            ControlEffect::CancelStandalone(operation_id) => {
                if let Some(operation_id) = operation_id {
                    if crate::actions::cancel_dictation_operation(operation_id) {
                        crate::actions::cancel_ask_selection_operation(app, operation_id);
                        utils::cancel_non_meeting_operation(app);
                    } else {
                        debug!("Ignoring cancellation after dictation operation committed");
                    }
                } else {
                    utils::cancel_non_meeting_operation(app);
                }
            }
            ControlEffect::CancelQuickRecording { meeting, quick } => {
                crate::actions::cancel_meeting_quick_dictation_recording(
                    app,
                    &quick.binding_id,
                    &meeting.binding_id,
                    quick.id,
                );
            }
            ControlEffect::CancelQuickProcessing(operation) => {
                crate::actions::cancel_meeting_quick_dictation_operation(app, operation.id);
            }
            ControlEffect::CancelStoppingDictationRecording(operation) => {
                crate::actions::cancel_standalone_dictation_recording_operation(
                    app,
                    &operation.binding_id,
                    operation.id,
                );
            }
            ControlEffect::CancelStoppingDictationProcessing(operation) => {
                crate::actions::cancel_standalone_dictation_processing_operation(app, operation.id);
            }
            ControlEffect::ClearQuickUi(operation_id) => {
                crate::actions::clear_active_quick_dictation_ui_operation(operation_id);
            }
            ControlEffect::IgnoreCancel => {
                shortcut::unregister_cancel_shortcut(app);
                debug!("Ignoring Escape while meeting-owned work remains active");
            }
        }
    }
}

fn start(app: &AppHandle, stage: &mut Stage, binding_id: &str, hotkey_string: &str) {
    let start_time = Instant::now();
    let operation = Operation::new(binding_id);

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
        *stage = if binding_id == "transcribe_full_system_audio" && full_system_active {
            Stage::MeetingRecording {
                meeting: operation,
                quick_dictation: None,
            }
        } else {
            Stage::Recording(operation)
        };
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

fn transition_legacy_meeting_processing_to_dictation(
    stage: &mut Stage,
    dictation: Operation,
) -> bool {
    let Stage::Processing(meeting) = stage else {
        return false;
    };
    if meeting.binding_id != "transcribe_full_system_audio" {
        return false;
    }

    *stage = Stage::MeetingStopping {
        meeting: meeting.clone(),
        dictation: Some(QuickDictationStage::Recording(dictation)),
        meeting_finished: false,
    };
    true
}

fn start_legacy_meeting_processing_dictation(
    app: &AppHandle,
    stage: &mut Stage,
    binding_id: &str,
    hotkey_string: &str,
) {
    let operation = Operation::new(binding_id);
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.start(app, binding_id, hotkey_string);

    let audio_recording_active = app
        .try_state::<Arc<AudioRecordingManager>>()
        .and_then(|manager| manager.current_recording_started_at(binding_id))
        .is_some();

    if audio_recording_active {
        if transition_legacy_meeting_processing_to_dictation(stage, operation) {
            info!("Started dictation while legacy meeting finalization remains active");
        }
    } else {
        warn!("Dictation did not start while legacy meeting finalization remains active");
    }
}

fn handle_meeting_quick_dictation_input(
    app: &AppHandle,
    stage: &mut Stage,
    binding_id: &str,
    hotkey_string: &str,
    push_to_talk: bool,
    is_pressed: bool,
) -> bool {
    if binding_id != "transcribe" {
        return false;
    }

    match stage {
        Stage::MeetingRecording {
            meeting,
            quick_dictation,
        } => handle_recording_meeting_dictation_input(
            app,
            meeting,
            quick_dictation,
            binding_id,
            hotkey_string,
            push_to_talk,
            is_pressed,
        ),
        Stage::MeetingStopping {
            dictation,
            meeting_finished: _,
            meeting: _,
        } => handle_stopping_meeting_dictation_input(
            app,
            dictation,
            binding_id,
            hotkey_string,
            push_to_talk,
            is_pressed,
        ),
        _ => false,
    }
}

fn handle_recording_meeting_dictation_input(
    app: &AppHandle,
    meeting: &Operation,
    quick_dictation: &mut Option<QuickDictationStage>,
    binding_id: &str,
    hotkey_string: &str,
    push_to_talk: bool,
    is_pressed: bool,
) -> bool {
    match quick_dictation_input_action(binding_id, push_to_talk, is_pressed, quick_dictation) {
        Some(QuickDictationInputAction::Start) => {
            start_meeting_quick_dictation(
                app,
                &meeting.binding_id,
                quick_dictation,
                binding_id,
                hotkey_string,
            );
            true
        }
        Some(QuickDictationInputAction::Stop) => {
            let Some(QuickDictationStage::Recording(operation)) = quick_dictation.as_ref() else {
                return true;
            };
            let operation = operation.clone();
            stop_tracked_dictation(app, quick_dictation, &operation, hotkey_string);
            true
        }
        Some(QuickDictationInputAction::Ignore) => {
            debug!("Ignoring quick dictation press while meeting quick dictation is active");
            true
        }
        None => false,
    }
}

fn handle_stopping_meeting_dictation_input(
    app: &AppHandle,
    dictation: &mut Option<QuickDictationStage>,
    binding_id: &str,
    hotkey_string: &str,
    push_to_talk: bool,
    is_pressed: bool,
) -> bool {
    match quick_dictation_input_action(binding_id, push_to_talk, is_pressed, dictation) {
        Some(QuickDictationInputAction::Start) => {
            start_stopping_meeting_dictation(app, dictation, binding_id, hotkey_string);
            true
        }
        Some(QuickDictationInputAction::Stop) => {
            let Some(QuickDictationStage::Recording(operation)) = dictation.as_ref() else {
                return true;
            };
            let operation = operation.clone();
            stop_tracked_dictation(app, dictation, &operation, hotkey_string);
            true
        }
        Some(QuickDictationInputAction::Ignore) => {
            debug!("Ignoring dictation press while meeting finalization dictation is active");
            true
        }
        None => false,
    }
}

fn quick_dictation_input_action(
    binding_id: &str,
    push_to_talk: bool,
    is_pressed: bool,
    quick_dictation: &Option<QuickDictationStage>,
) -> Option<QuickDictationInputAction> {
    if binding_id != "transcribe" {
        return None;
    }

    match (push_to_talk, is_pressed, quick_dictation) {
        (true, true, None) => Some(QuickDictationInputAction::Start),
        (true, false, Some(QuickDictationStage::Recording(active)))
            if active.binding_id == binding_id =>
        {
            Some(QuickDictationInputAction::Stop)
        }
        (true, _, _) => Some(QuickDictationInputAction::Ignore),
        (false, true, None) => Some(QuickDictationInputAction::Start),
        (false, true, Some(QuickDictationStage::Recording(active)))
            if active.binding_id == binding_id =>
        {
            Some(QuickDictationInputAction::Stop)
        }
        (false, _, _) => Some(QuickDictationInputAction::Ignore),
    }
}

fn start_meeting_quick_dictation(
    app: &AppHandle,
    meeting_binding_id: &str,
    quick_dictation: &mut Option<QuickDictationStage>,
    binding_id: &str,
    hotkey_string: &str,
) {
    let operation = Operation::new(binding_id);
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    crate::actions::set_active_quick_dictation_ui_operation(operation.id);
    action.start(app, binding_id, hotkey_string);

    let audio_recording_active = app
        .try_state::<Arc<AudioRecordingManager>>()
        .and_then(|a| a.current_recording_started_at(binding_id))
        .is_some();

    if audio_recording_active {
        *quick_dictation = Some(QuickDictationStage::Recording(operation));
        info!(
            "Started quick dictation '{}' while meeting '{}' remains active",
            binding_id, meeting_binding_id
        );
    } else {
        crate::actions::clear_active_quick_dictation_ui_operation(operation.id);
        warn!(
            "Quick dictation '{}' did not start while meeting '{}' remains active",
            binding_id, meeting_binding_id
        );
    }
}

fn start_stopping_meeting_dictation(
    app: &AppHandle,
    dictation: &mut Option<QuickDictationStage>,
    binding_id: &str,
    hotkey_string: &str,
) {
    let operation = Operation::new(binding_id);
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.start(app, binding_id, hotkey_string);

    let audio_recording_active = app
        .try_state::<Arc<AudioRecordingManager>>()
        .and_then(|manager| manager.current_recording_started_at(binding_id))
        .is_some();

    if audio_recording_active {
        *dictation = Some(QuickDictationStage::Recording(operation));
        info!("Started dictation while meeting finalization remains active");
    } else {
        warn!("Dictation did not start while meeting finalization remains active");
    }
}

fn stop_tracked_dictation(
    app: &AppHandle,
    quick_dictation: &mut Option<QuickDictationStage>,
    operation: &Operation,
    hotkey_string: &str,
) {
    let binding_id = &operation.binding_id;
    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.stop(app, binding_id, hotkey_string, operation.id);
    *quick_dictation = Some(QuickDictationStage::Processing(operation.clone()));
    info!(
        "Stopped quick dictation '{}' while meeting remains active",
        binding_id
    );
}

fn transition_to_meeting_stopping(
    stage: &mut Stage,
    meeting: &Operation,
    quick_processing: Option<Operation>,
) {
    *stage = Stage::MeetingStopping {
        meeting: meeting.clone(),
        dictation: quick_processing.map(QuickDictationStage::Processing),
        meeting_finished: false,
    };
}

#[cfg(test)]
pub(crate) struct MeetingControlTestDriver {
    stage: Stage,
}

#[cfg(test)]
impl MeetingControlTestDriver {
    pub(crate) fn with_processing_quick(meeting_id: OperationId, quick_id: OperationId) -> Self {
        Self {
            stage: Stage::MeetingRecording {
                meeting: Operation::with_id("transcribe_full_system_audio", meeting_id),
                quick_dictation: Some(QuickDictationStage::Processing(Operation::with_id(
                    "transcribe",
                    quick_id,
                ))),
            },
        }
    }

    pub(crate) fn request_user_cancel(&mut self) -> OperationId {
        let effects = apply_control_command(&mut self.stage, &Command::UserCancel);
        let [ControlEffect::CancelQuickProcessing(operation)] = effects.as_slice() else {
            panic!("production cancel command should target only the nested quick operation");
        };
        operation.id
    }

    pub(crate) fn request_meeting_stop(&mut self) -> OperationId {
        let effects = apply_control_command(&mut self.stage, &Command::StopMeeting);
        let [ControlEffect::DispatchMeetingStop(meeting)] = effects.as_slice() else {
            panic!("production Stop command should dispatch one meeting finalization");
        };
        meeting.id
    }

    pub(crate) fn notify_stale_quick_finished(&mut self, quick_id: OperationId) {
        let stage_before = self.stage.clone();
        let effects = apply_control_command(
            &mut self.stage,
            &Command::ProcessingFinished {
                binding_id: "transcribe".to_string(),
                operation_id: quick_id,
            },
        );
        assert_eq!(effects, vec![ControlEffect::ClearQuickUi(quick_id)]);
        assert_eq!(self.stage, stage_before);
    }

    pub(crate) fn assert_duplicate_stop_is_ignored(&mut self) {
        assert!(apply_control_command(&mut self.stage, &Command::StopMeeting).is_empty());
    }

    pub(crate) fn notify_meeting_finished(&mut self, meeting_id: OperationId) {
        let effects = apply_control_command(
            &mut self.stage,
            &Command::ProcessingFinished {
                binding_id: "transcribe_full_system_audio".to_string(),
                operation_id: meeting_id,
            },
        );
        assert_eq!(effects, vec![ControlEffect::ClearQuickUi(meeting_id)]);
        assert_eq!(self.stage, Stage::Idle);
    }
}

fn dispatch_meeting_stop(app: &AppHandle, meeting: &Operation) {
    let Some(action) = ACTION_MAP.get(&meeting.binding_id) else {
        warn!("No action in ACTION_MAP for '{}'", meeting.binding_id);
        return;
    };
    action.stop(app, &meeting.binding_id, "Home Stop", meeting.id);
}

fn finish_processing_stage(
    stage: &mut Stage,
    binding_id: &str,
    operation_id: OperationId,
) -> ProcessingFinishedAction {
    match stage {
        Stage::MeetingRecording {
            meeting,
            quick_dictation: Some(QuickDictationStage::Processing(active)),
        } if active.matches(binding_id, operation_id) => {
            *stage = Stage::MeetingRecording {
                meeting: meeting.clone(),
                quick_dictation: None,
            };
            ProcessingFinishedAction::None
        }
        Stage::Processing(active) if active.matches(binding_id, operation_id) => {
            *stage = Stage::Idle;
            ProcessingFinishedAction::None
        }
        Stage::MeetingStopPendingQuick {
            meeting,
            quick_processing,
        } if quick_processing.matches(binding_id, operation_id) => {
            let meeting = meeting.clone();
            *stage = Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: None,
                meeting_finished: false,
            };
            ProcessingFinishedAction::DispatchMeetingStop(meeting)
        }
        Stage::MeetingStopping {
            meeting,
            dictation,
            meeting_finished,
        } if meeting.matches(binding_id, operation_id) => {
            if dictation.is_none() {
                *stage = Stage::Idle;
            } else {
                *stage = Stage::MeetingStopping {
                    meeting: meeting.clone(),
                    dictation: dictation.clone(),
                    meeting_finished: true,
                };
            }
            ProcessingFinishedAction::None
        }
        Stage::MeetingStopping {
            meeting,
            dictation: Some(QuickDictationStage::Processing(active)),
            meeting_finished,
        } if active.matches(binding_id, operation_id) => {
            if *meeting_finished {
                *stage = Stage::Idle;
            } else {
                *stage = Stage::MeetingStopping {
                    meeting: meeting.clone(),
                    dictation: None,
                    meeting_finished: false,
                };
            }
            ProcessingFinishedAction::None
        }
        _ => ProcessingFinishedAction::None,
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

fn should_debounce_press(
    last_press: &Option<(String, Instant)>,
    binding_id: &str,
    received_at: Instant,
) -> bool {
    last_press
        .as_ref()
        .map(|(last_binding_id, last_received_at)| {
            last_binding_id == binding_id
                && received_at.saturating_duration_since(*last_received_at) < DEBOUNCE
        })
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

    let Stage::Recording(operation) = stage else {
        debug!("Ignoring stop for '{binding_id}' outside a recording stage");
        return;
    };
    if operation.binding_id != binding_id {
        debug!("Ignoring stop for inactive binding '{binding_id}'");
        return;
    }
    let operation = operation.clone();

    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!("No action in ACTION_MAP for '{binding_id}'");
        return;
    };
    action.stop(app, binding_id, hotkey_string, operation.id);
    *stage = Stage::Processing(operation);
    info!(
        "[latency] coordinator stop dispatched binding={} elapsed_ms={}",
        binding_id,
        stop_time.elapsed().as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::{
        apply_control_command, begin_meeting_stop_after_pending_quick_cancel,
        can_start_dictation_while_legacy_meeting_processing, cancel_shortcut_should_be_registered,
        defer_meeting_stop_until_quick_finishes, finish_processing_stage,
        is_repeated_meeting_input, is_transcribe_binding, meeting_stop_action, next_operation_id,
        processing_watchdog_can_reset, quick_dictation_input_action,
        release_received_before_recording_started, should_debounce_press,
        transcribe_binding_push_to_talk, transcription_session_is_active,
        transition_legacy_meeting_processing_to_dictation, user_cancel_action, Command,
        ControlEffect, MeetingStopAction, Operation, ProcessingFinishedAction,
        PushToTalkSuppression, QuickDictationInputAction, QuickDictationStage, Stage,
        UserCancelAction, DEBOUNCE, SUPPRESS_AFTER_IGNORED_PUSH_TO_TALK_RELEASE,
    };
    use std::time::{Duration, Instant};

    fn operation(binding_id: &str, id: u64) -> Operation {
        Operation::with_id(binding_id, id)
    }

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
    fn quick_dictation_finish_returns_to_meeting_recording_stage() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let quick = operation("transcribe", 2);
        let mut stage = Stage::MeetingRecording {
            meeting: meeting.clone(),
            quick_dictation: Some(QuickDictationStage::Processing(quick.clone())),
        };

        finish_processing_stage(&mut stage, &quick.binding_id, quick.id);

        assert_eq!(
            stage,
            Stage::MeetingRecording {
                meeting,
                quick_dictation: None,
            }
        );
    }

    #[test]
    fn repeated_meeting_stop_is_ignored_after_finalization_starts() {
        let stage = Stage::MeetingStopping {
            meeting: operation("transcribe_full_system_audio", 1),
            dictation: None,
            meeting_finished: false,
        };

        assert_eq!(meeting_stop_action(&stage), MeetingStopAction::Ignore);
    }

    #[test]
    fn repeated_meeting_hotkey_input_is_ignored() {
        let stage = Stage::MeetingRecording {
            meeting: operation("transcribe_full_system_audio", 1),
            quick_dictation: None,
        };

        assert!(is_repeated_meeting_input(
            &stage,
            "transcribe_full_system_audio"
        ));
        assert!(!is_repeated_meeting_input(&stage, "transcribe"));
    }

    #[test]
    fn meeting_stop_handles_each_quick_dictation_stage() {
        let meeting = |quick_dictation| Stage::MeetingRecording {
            meeting: operation("transcribe_full_system_audio", 1),
            quick_dictation,
        };

        assert_eq!(
            meeting_stop_action(&meeting(None)),
            MeetingStopAction::StopMeeting
        );
        assert_eq!(
            meeting_stop_action(&meeting(Some(QuickDictationStage::Recording(operation(
                "transcribe",
                2
            ))))),
            MeetingStopAction::StopQuickThenMeeting
        );
        assert_eq!(
            meeting_stop_action(&meeting(Some(QuickDictationStage::Processing(operation(
                "transcribe",
                2
            ))))),
            MeetingStopAction::StopMeetingAndWaitForQuick
        );
    }

    #[test]
    fn escape_is_noop_for_meeting_only_and_meeting_stopping() {
        assert_eq!(
            user_cancel_action(&Stage::MeetingRecording {
                meeting: operation("transcribe_full_system_audio", 1),
                quick_dictation: None,
            }),
            UserCancelAction::Ignore
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingStopping {
                meeting: operation("transcribe_full_system_audio", 1),
                dictation: None,
                meeting_finished: false,
            }),
            UserCancelAction::Ignore
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingStopPendingQuick {
                meeting: operation("transcribe_full_system_audio", 1),
                quick_processing: operation("transcribe", 2),
            }),
            UserCancelAction::CancelPendingQuickProcessing
        );
    }

    #[test]
    fn escape_cancels_pending_quick_then_waits_for_both_meeting_completions() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let quick = operation("transcribe", 2);
        let mut stage = Stage::MeetingStopPendingQuick {
            meeting: meeting.clone(),
            quick_processing: quick.clone(),
        };

        assert_eq!(
            begin_meeting_stop_after_pending_quick_cancel(&mut stage),
            Some((meeting.clone(), quick.clone()))
        );
        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: Some(QuickDictationStage::Processing(quick.clone())),
                meeting_finished: false,
            }
        );

        finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id);
        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting,
                dictation: Some(QuickDictationStage::Processing(quick.clone())),
                meeting_finished: true,
            }
        );
        finish_processing_stage(&mut stage, &quick.binding_id, quick.id);
        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn escape_targets_only_the_active_dictation_stage() {
        assert_eq!(
            user_cancel_action(&Stage::Recording(operation("transcribe", 1))),
            UserCancelAction::CancelStandalone
        );
        assert_eq!(
            user_cancel_action(&Stage::Processing(operation("transcribe", 1))),
            UserCancelAction::CancelStandalone
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingRecording {
                meeting: operation("transcribe_full_system_audio", 1),
                quick_dictation: Some(QuickDictationStage::Recording(operation("transcribe", 2,))),
            }),
            UserCancelAction::CancelQuickRecording
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingRecording {
                meeting: operation("transcribe_full_system_audio", 1),
                quick_dictation: Some(QuickDictationStage::Processing(operation("transcribe", 2,))),
            }),
            UserCancelAction::CancelQuickProcessing
        );
        assert_eq!(
            user_cancel_action(&Stage::Processing(operation(
                "transcribe_full_system_audio",
                3,
            ))),
            UserCancelAction::Ignore
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingStopping {
                meeting: operation("transcribe_full_system_audio", 1),
                dictation: Some(QuickDictationStage::Recording(operation("transcribe", 2))),
                meeting_finished: false,
            }),
            UserCancelAction::CancelStoppingDictationRecording
        );
        assert_eq!(
            user_cancel_action(&Stage::MeetingStopping {
                meeting: operation("transcribe_full_system_audio", 1),
                dictation: Some(QuickDictationStage::Processing(operation("transcribe", 2))),
                meeting_finished: false,
            }),
            UserCancelAction::CancelStoppingDictationProcessing
        );
    }

    #[test]
    fn toggle_quick_dictation_press_starts_and_second_press_stops_during_meeting() {
        assert_eq!(
            quick_dictation_input_action("transcribe", false, true, &None),
            Some(QuickDictationInputAction::Start)
        );
        assert_eq!(
            quick_dictation_input_action(
                "transcribe",
                false,
                true,
                &Some(QuickDictationStage::Recording(operation("transcribe", 2)))
            ),
            Some(QuickDictationInputAction::Stop)
        );
    }

    #[test]
    fn push_to_talk_quick_dictation_still_stops_on_release_during_meeting() {
        assert_eq!(
            quick_dictation_input_action("transcribe", true, true, &None),
            Some(QuickDictationInputAction::Start)
        );
        assert_eq!(
            quick_dictation_input_action(
                "transcribe",
                true,
                false,
                &Some(QuickDictationStage::Recording(operation("transcribe", 2)))
            ),
            Some(QuickDictationInputAction::Stop)
        );
    }

    #[test]
    fn meeting_processing_finish_returns_to_idle() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let mut stage = Stage::Processing(meeting.clone());

        finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id);

        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn meeting_processing_allows_starting_normal_dictation() {
        let stage = Stage::Processing(operation("transcribe_full_system_audio", 1));

        assert!(can_start_dictation_while_legacy_meeting_processing(
            &stage,
            "transcribe"
        ));
    }

    #[test]
    fn legacy_meeting_processing_keeps_ownership_across_dictation_cancel() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let dictation = operation("transcribe", 2);
        let mut stage = Stage::Processing(meeting.clone());

        assert!(transition_legacy_meeting_processing_to_dictation(
            &mut stage,
            dictation.clone(),
        ));
        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: Some(QuickDictationStage::Recording(dictation.clone())),
                meeting_finished: false,
            }
        );

        assert_eq!(
            apply_control_command(&mut stage, &Command::UserCancel),
            vec![ControlEffect::CancelStoppingDictationRecording(
                dictation.clone()
            )]
        );
        let meeting_only = Stage::MeetingStopping {
            meeting: meeting.clone(),
            dictation: None,
            meeting_finished: false,
        };
        assert_eq!(stage, meeting_only);
        assert!(is_repeated_meeting_input(
            &stage,
            "transcribe_full_system_audio"
        ));

        assert_eq!(
            apply_control_command(
                &mut stage,
                &Command::ProcessingFinished {
                    binding_id: dictation.binding_id.clone(),
                    operation_id: dictation.id,
                },
            ),
            vec![ControlEffect::ClearQuickUi(dictation.id)]
        );
        assert_eq!(stage, meeting_only);

        assert_eq!(
            apply_control_command(
                &mut stage,
                &Command::ProcessingFinished {
                    binding_id: meeting.binding_id.clone(),
                    operation_id: meeting.id,
                },
            ),
            vec![ControlEffect::ClearQuickUi(meeting.id)]
        );
        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn normal_processing_does_not_allow_starting_another_normal_dictation() {
        let stage = Stage::Processing(operation("transcribe", 1));

        assert!(!can_start_dictation_while_legacy_meeting_processing(
            &stage,
            "transcribe"
        ));
    }

    #[test]
    fn unrelated_processing_finish_does_not_interrupt_active_recording() {
        let active = operation("transcribe", 1);
        let mut stage = Stage::Recording(active.clone());

        finish_processing_stage(&mut stage, "transcribe_full_system_audio", 2);

        assert_eq!(stage, Stage::Recording(active));
    }

    #[test]
    fn late_completion_from_cancelled_quick_a_does_not_clear_new_quick_b() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let quick_a = operation("transcribe", 2);
        let quick_b = operation("transcribe", 3);
        let mut stage = Stage::MeetingRecording {
            meeting: meeting.clone(),
            quick_dictation: Some(QuickDictationStage::Processing(quick_b.clone())),
        };

        finish_processing_stage(&mut stage, &quick_a.binding_id, quick_a.id);

        assert_eq!(
            stage,
            Stage::MeetingRecording {
                meeting: meeting.clone(),
                quick_dictation: Some(QuickDictationStage::Processing(quick_b.clone())),
            }
        );

        finish_processing_stage(&mut stage, &quick_b.binding_id, quick_b.id);

        assert_eq!(
            stage,
            Stage::MeetingRecording {
                meeting,
                quick_dictation: None,
            }
        );
    }

    #[test]
    fn meeting_stop_defers_dispatch_until_exact_quick_processing_finishes() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let stale_quick = operation("transcribe", 2);
        let quick = operation("transcribe", 2);
        let quick = Operation::with_id(&quick.binding_id, 3);
        let mut stage = Stage::MeetingRecording {
            meeting: meeting.clone(),
            quick_dictation: Some(QuickDictationStage::Processing(quick.clone())),
        };

        defer_meeting_stop_until_quick_finishes(&mut stage, meeting.clone(), quick.clone());

        assert_eq!(
            stage,
            Stage::MeetingStopPendingQuick {
                meeting: meeting.clone(),
                quick_processing: quick.clone(),
            }
        );

        assert_eq!(
            finish_processing_stage(&mut stage, &stale_quick.binding_id, stale_quick.id),
            ProcessingFinishedAction::None
        );
        assert_eq!(
            stage,
            Stage::MeetingStopPendingQuick {
                meeting: meeting.clone(),
                quick_processing: quick.clone(),
            }
        );

        assert_eq!(
            finish_processing_stage(&mut stage, &quick.binding_id, quick.id),
            ProcessingFinishedAction::DispatchMeetingStop(meeting.clone())
        );

        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: None,
                meeting_finished: false,
            }
        );

        finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id);

        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn full_system_fallback_keeps_meeting_stopping_until_fallback_save_finishes() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let mut stage = Stage::MeetingStopping {
            meeting: meeting.clone(),
            dictation: None,
            meeting_finished: false,
        };

        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: None,
                meeting_finished: false,
            }
        );

        assert_eq!(
            finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id),
            ProcessingFinishedAction::None
        );

        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn dictation_can_finish_while_meeting_finalization_retains_ownership() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let dictation = operation("transcribe", 2);
        let mut stage = Stage::MeetingStopping {
            meeting: meeting.clone(),
            dictation: Some(QuickDictationStage::Processing(dictation.clone())),
            meeting_finished: false,
        };

        finish_processing_stage(&mut stage, &dictation.binding_id, dictation.id);
        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting: meeting.clone(),
                dictation: None,
                meeting_finished: false,
            }
        );

        finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id);
        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn meeting_can_finish_while_dictation_processing_retains_ownership() {
        let meeting = operation("transcribe_full_system_audio", 1);
        let dictation = operation("transcribe", 2);
        let mut stage = Stage::MeetingStopping {
            meeting: meeting.clone(),
            dictation: Some(QuickDictationStage::Processing(dictation.clone())),
            meeting_finished: false,
        };

        finish_processing_stage(&mut stage, &meeting.binding_id, meeting.id);
        assert_eq!(
            stage,
            Stage::MeetingStopping {
                meeting,
                dictation: Some(QuickDictationStage::Processing(dictation.clone())),
                meeting_finished: true,
            }
        );

        finish_processing_stage(&mut stage, &dictation.binding_id, dictation.id);
        assert_eq!(stage, Stage::Idle);
    }

    #[test]
    fn processing_watchdog_never_resets_meeting_finalization() {
        assert!(processing_watchdog_can_reset(&Stage::Processing(
            operation("transcribe", 1,)
        )));
        assert!(!processing_watchdog_can_reset(&Stage::MeetingStopping {
            meeting: operation("transcribe_full_system_audio", 1),
            dictation: Some(QuickDictationStage::Processing(operation("transcribe", 2))),
            meeting_finished: false,
        }));
        assert!(!processing_watchdog_can_reset(&Stage::Processing(
            operation("transcribe_full_system_audio", 3)
        )));
        assert!(!processing_watchdog_can_reset(
            &Stage::MeetingStopPendingQuick {
                meeting: operation("transcribe_full_system_audio", 1),
                quick_processing: operation("transcribe", 2),
            }
        ));
        assert!(!processing_watchdog_can_reset(&Stage::Idle));
        assert!(!processing_watchdog_can_reset(&Stage::MeetingRecording {
            meeting: operation("transcribe_full_system_audio", 1),
            quick_dictation: Some(QuickDictationStage::Processing(operation("transcribe", 2))),
        }));
    }

    #[test]
    fn escape_registration_follows_dictation_processing_lifecycle() {
        assert!(cancel_shortcut_should_be_registered(&Stage::Recording(
            operation("transcribe", 1)
        )));
        assert!(cancel_shortcut_should_be_registered(&Stage::Processing(
            operation("transcribe", 1)
        )));
        assert!(cancel_shortcut_should_be_registered(
            &Stage::MeetingRecording {
                meeting: operation("transcribe_full_system_audio", 2),
                quick_dictation: Some(QuickDictationStage::Processing(operation("transcribe", 3))),
            }
        ));
        assert!(cancel_shortcut_should_be_registered(
            &Stage::MeetingStopPendingQuick {
                meeting: operation("transcribe_full_system_audio", 2),
                quick_processing: operation("transcribe", 3),
            }
        ));
        assert!(cancel_shortcut_should_be_registered(
            &Stage::MeetingStopping {
                meeting: operation("transcribe_full_system_audio", 2),
                dictation: Some(QuickDictationStage::Processing(operation("transcribe", 3))),
                meeting_finished: false,
            }
        ));
        assert!(!cancel_shortcut_should_be_registered(&Stage::Processing(
            operation("transcribe_full_system_audio", 4)
        )));
        assert!(!cancel_shortcut_should_be_registered(
            &Stage::MeetingRecording {
                meeting: operation("transcribe_full_system_audio", 2),
                quick_dictation: None,
            }
        ));
        assert!(!cancel_shortcut_should_be_registered(&Stage::Idle));
    }

    #[test]
    fn operation_ids_are_monotonically_increasing() {
        let first = next_operation_id();
        let second = next_operation_id();

        assert!(second > first);
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
    fn press_debounce_only_suppresses_same_binding_repeats() {
        let now = Instant::now();
        let last_press = Some(("transcribe".to_string(), now));

        assert!(should_debounce_press(
            &last_press,
            "transcribe",
            now + DEBOUNCE - Duration::from_millis(1)
        ));
        assert!(!should_debounce_press(
            &last_press,
            "edit_mode",
            now + Duration::from_millis(1)
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
