//! Handy-keys based keyboard shortcut implementation
//!
//! This module provides an alternative to Tauri's global-shortcut plugin
//! using the handy-keys library for more control over keyboard events.
//!
//! ## Architecture
//!
//! The implementation uses a dedicated manager thread that owns the `HotkeyManager`:
//!
//! ```text
//! ┌─────────────────┐     commands      ┌──────────────────────┐
//! │   Main Thread   │ ───────────────▶ │   Manager Thread     │
//! │                 │   (via channel)   │                      │
//! │ - register()    │                   │ - owns HotkeyManager │
//! │ - unregister()  │                   │ - polls for events   │
//! └─────────────────┘                   │ - dispatches actions │
//!                                       └──────────────────────┘
//! ```
//!
//! This design ensures thread-safety since `HotkeyManager` is only accessed
//! from a single thread. Commands (register/unregister) are sent via an mpsc
//! channel and responses are synchronously awaited.
//!
//! ## Recording Mode
//!
//! For UI key capture, a separate `KeyboardListener` is created on-demand and
//! polled from a dedicated recording thread. Events are emitted to the frontend
//! via Tauri's event system.

use handy_keys::{Hotkey, HotkeyId, HotkeyManager, HotkeyState, KeyEvent, KeyboardListener};
use log::{debug, error, info, warn};
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, get_settings, ShortcutBinding};
use crate::transcription_coordinator::{is_transcribe_binding, transcribe_binding_push_to_talk};

use super::handler::handle_shortcut_event;

const MODIFIER_ONLY_STALE_TIMEOUT: Duration = Duration::from_millis(750);
const MODIFIER_ONLY_CHORD_WINDOW: Duration = Duration::from_millis(500);

/// Commands that can be sent to the hotkey manager thread
enum ManagerCommand {
    Register {
        binding_id: String,
        hotkey_string: String,
        response: Sender<Result<(), String>>,
    },
    Unregister {
        binding_id: String,
        response: Sender<Result<(), String>>,
    },
    Shutdown,
}

/// State for the handy-keys shortcut manager
pub struct HandyKeysState {
    /// Channel to send commands to the manager thread (wrapped in Mutex for Sync)
    command_sender: Mutex<Sender<ManagerCommand>>,
    /// Handle to the manager thread (wrapped in Mutex for Sync, allows proper join on drop)
    thread_handle: Mutex<Option<JoinHandle<()>>>,
    /// Recording listener for UI key capture (only active during recording)
    recording_listener: Mutex<Option<KeyboardListener>>,
    /// Flag indicating if we're in recording mode
    is_recording: AtomicBool,
    /// The binding ID being recorded (if any)
    recording_binding_id: Mutex<Option<String>>,
    /// Flag to stop recording loop
    recording_running: Arc<AtomicBool>,
}

/// Key event sent to frontend during recording mode
#[derive(Debug, Clone, Serialize, Type)]
pub struct FrontendKeyEvent {
    /// Currently pressed modifier keys
    pub modifiers: Vec<String>,
    /// The key that was pressed (if any)
    pub key: Option<String>,
    /// Whether this is a key down event
    pub is_key_down: bool,
    /// The full hotkey string (e.g., "option+space")
    pub hotkey_string: String,
}

#[derive(Clone)]
struct ActivePushToTalkGuard {
    hotkey: Hotkey,
    hotkey_string: String,
}

#[derive(Default)]
struct ModifierOnlyTracker {
    active: [bool; 5],
    last_pressed_at: [Option<Instant>; 5],
}

impl ModifierOnlyTracker {
    fn clear_stale_before_modifier_press(
        &mut self,
        event: &KeyEvent,
        now: Instant,
        allow_stale_recovery: bool,
    ) {
        if !allow_stale_recovery || !event.is_key_down {
            return;
        }

        let Some(changed_family) = modifier_family_index(event.changed_modifier) else {
            return;
        };

        for family in 0..self.active.len() {
            if family == changed_family || !self.active[family] {
                continue;
            }

            let is_stale = self.last_pressed_at[family].is_some_and(|pressed_at| {
                now.duration_since(pressed_at) > MODIFIER_ONLY_STALE_TIMEOUT
            });
            if is_stale {
                self.active[family] = false;
            }
        }
    }

    fn apply(&mut self, event: &KeyEvent, now: Instant) {
        let Some(family) = modifier_family_index(event.changed_modifier) else {
            return;
        };

        self.active[family] = event.is_key_down;
        if event.is_key_down {
            self.last_pressed_at[family] = Some(now);
        }
    }

    fn modifiers(&self) -> handy_keys::Modifiers {
        let mut modifiers = handy_keys::Modifiers::empty();

        if self.active[0] {
            modifiers |= handy_keys::Modifiers::CTRL;
        }
        if self.active[1] {
            modifiers |= handy_keys::Modifiers::OPT;
        }
        if self.active[2] {
            modifiers |= handy_keys::Modifiers::SHIFT;
        }
        if self.active[3] {
            modifiers |= handy_keys::Modifiers::CMD;
        }
        if self.active[4] {
            modifiers |= handy_keys::Modifiers::FN;
        }

        modifiers
    }

    fn modifier_only_press_is_fresh(&self, hotkey: Hotkey, now: Instant) -> bool {
        modifier_family_signature(hotkey.modifiers)
            .into_iter()
            .enumerate()
            .all(|(family, required)| {
                !required
                    || self.last_pressed_at[family].is_some_and(|pressed_at| {
                        now.duration_since(pressed_at) <= MODIFIER_ONLY_CHORD_WINDOW
                    })
            })
    }
}

impl HandyKeysState {
    /// Create a new HandyKeysState
    pub fn new(app: AppHandle) -> Result<Self, String> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<ManagerCommand>();

        // Start the manager thread
        let app_clone = app.clone();
        let thread_handle = thread::spawn(move || {
            Self::manager_thread(cmd_rx, app_clone);
        });

        Ok(Self {
            command_sender: Mutex::new(cmd_tx),
            thread_handle: Mutex::new(Some(thread_handle)),
            recording_listener: Mutex::new(None),
            is_recording: AtomicBool::new(false),
            recording_binding_id: Mutex::new(None),
            recording_running: Arc::new(AtomicBool::new(false)),
        })
    }

    /// The main manager thread - owns the HotkeyManager and processes commands
    fn manager_thread(cmd_rx: Receiver<ManagerCommand>, app: AppHandle) {
        info!("handy-keys manager thread started");

        // Create the HotkeyManager in this thread
        let manager = match HotkeyManager::new() {
            Ok(m) => m,
            Err(e) => {
                error!("Failed to create HotkeyManager: {}", e);
                return;
            }
        };

        // Raw listener covers modifier-only shortcuts and push-to-talk release recovery.
        let raw_listener = match KeyboardListener::new() {
            Ok(listener) => Some(listener),
            Err(e) => {
                error!("Failed to create handy-keys raw listener: {}", e);
                None
            }
        };

        // Maps binding IDs to HotkeyIds and hotkey strings
        let mut binding_to_hotkey: HashMap<String, HotkeyId> = HashMap::new();
        let mut hotkey_to_binding: HashMap<HotkeyId, (String, String)> = HashMap::new(); // (binding_id, hotkey_string)
        let mut modifier_only_bindings: HashMap<String, (Hotkey, String)> = HashMap::new();
        let mut pressed_modifier_only: HashSet<String> = HashSet::new();
        let mut modifier_only_tracker = ModifierOnlyTracker::default();
        let mut active_push_to_talk: HashMap<String, ActivePushToTalkGuard> = HashMap::new();

        loop {
            // Check for hotkey events (non-blocking)
            while let Some(event) = manager.try_recv() {
                if let Some((binding_id, hotkey_string)) = hotkey_to_binding.get(&event.id) {
                    debug!(
                        "handy-keys event: binding={}, hotkey={}, state={:?}",
                        binding_id, hotkey_string, event.state
                    );
                    let is_pressed = event.state == HotkeyState::Pressed;
                    Self::update_push_to_talk_guard(
                        &app,
                        &mut active_push_to_talk,
                        binding_id,
                        hotkey_string,
                        is_pressed,
                    );
                    handle_shortcut_event(&app, binding_id, hotkey_string, is_pressed);
                }
            }

            if let Some(listener) = raw_listener.as_ref() {
                while let Some(event) = listener.try_recv() {
                    let modifier_only_modifiers = if event.key.is_none() {
                        let now = Instant::now();
                        modifier_only_tracker.clear_stale_before_modifier_press(
                            &event,
                            now,
                            pressed_modifier_only.is_empty(),
                        );
                        modifier_only_tracker.apply(&event, now);
                        modifier_only_tracker.modifiers()
                    } else {
                        modifier_only_tracker.modifiers()
                    };

                    Self::dispatch_modifier_only_events(
                        &app,
                        &modifier_only_bindings,
                        &mut pressed_modifier_only,
                        &modifier_only_tracker,
                        &mut active_push_to_talk,
                        modifier_only_modifiers,
                        &event,
                    );
                    Self::dispatch_push_to_talk_release_guards(
                        &app,
                        &mut active_push_to_talk,
                        modifier_only_modifiers,
                        &event,
                    );
                }
            }

            // Check for commands (non-blocking with timeout)
            match cmd_rx.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(cmd) => match cmd {
                    ManagerCommand::Register {
                        binding_id,
                        hotkey_string,
                        response,
                    } => {
                        let result = Self::do_register(
                            &manager,
                            &mut binding_to_hotkey,
                            &mut hotkey_to_binding,
                            &mut modifier_only_bindings,
                            &mut pressed_modifier_only,
                            &mut active_push_to_talk,
                            &binding_id,
                            &hotkey_string,
                        );
                        let _ = response.send(result);
                    }
                    ManagerCommand::Unregister {
                        binding_id,
                        response,
                    } => {
                        let result = Self::do_unregister(
                            &manager,
                            &mut binding_to_hotkey,
                            &mut hotkey_to_binding,
                            &mut modifier_only_bindings,
                            &mut pressed_modifier_only,
                            &mut active_push_to_talk,
                            &binding_id,
                        );
                        let _ = response.send(result);
                    }
                    ManagerCommand::Shutdown => {
                        info!("handy-keys manager thread shutting down");
                        break;
                    }
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // No command, continue
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    info!("Command channel disconnected, shutting down");
                    break;
                }
            }
        }

        info!("handy-keys manager thread stopped");
    }

    /// Register a hotkey
    fn do_register(
        manager: &HotkeyManager,
        binding_to_hotkey: &mut HashMap<String, HotkeyId>,
        hotkey_to_binding: &mut HashMap<HotkeyId, (String, String)>,
        modifier_only_bindings: &mut HashMap<String, (Hotkey, String)>,
        pressed_modifier_only: &mut HashSet<String>,
        active_push_to_talk: &mut HashMap<String, ActivePushToTalkGuard>,
        binding_id: &str,
        hotkey_string: &str,
    ) -> Result<(), String> {
        let hotkey: Hotkey = hotkey_string
            .parse()
            .map_err(|e| format!("Failed to parse hotkey '{}': {}", hotkey_string, e))?;

        if hotkey.key.is_none() {
            modifier_only_bindings
                .insert(binding_id.to_string(), (hotkey, hotkey_string.to_string()));
            pressed_modifier_only.remove(binding_id);
            active_push_to_talk.remove(binding_id);
            debug!(
                "Registered handy-keys modifier-only shortcut: {} -> {}",
                binding_id, hotkey_string
            );
            return Ok(());
        }

        let id = manager
            .register(hotkey)
            .map_err(|e| format!("Failed to register hotkey: {}", e))?;

        binding_to_hotkey.insert(binding_id.to_string(), id);
        hotkey_to_binding.insert(id, (binding_id.to_string(), hotkey_string.to_string()));
        active_push_to_talk.remove(binding_id);

        debug!(
            "Registered handy-keys shortcut: {} -> {:?}",
            binding_id, hotkey
        );
        Ok(())
    }

    /// Unregister a hotkey
    fn do_unregister(
        manager: &HotkeyManager,
        binding_to_hotkey: &mut HashMap<String, HotkeyId>,
        hotkey_to_binding: &mut HashMap<HotkeyId, (String, String)>,
        modifier_only_bindings: &mut HashMap<String, (Hotkey, String)>,
        pressed_modifier_only: &mut HashSet<String>,
        active_push_to_talk: &mut HashMap<String, ActivePushToTalkGuard>,
        binding_id: &str,
    ) -> Result<(), String> {
        if modifier_only_bindings.remove(binding_id).is_some() {
            pressed_modifier_only.remove(binding_id);
            active_push_to_talk.remove(binding_id);
            debug!(
                "Unregistered handy-keys modifier-only shortcut: {}",
                binding_id
            );
            return Ok(());
        }

        if let Some(id) = binding_to_hotkey.remove(binding_id) {
            manager
                .unregister(id)
                .map_err(|e| format!("Failed to unregister hotkey: {}", e))?;
            hotkey_to_binding.remove(&id);
            active_push_to_talk.remove(binding_id);
            debug!("Unregistered handy-keys shortcut: {}", binding_id);
        }
        Ok(())
    }

    fn dispatch_modifier_only_events(
        app: &AppHandle,
        modifier_only_bindings: &HashMap<String, (Hotkey, String)>,
        pressed_modifier_only: &mut HashSet<String>,
        modifier_only_tracker: &ModifierOnlyTracker,
        active_push_to_talk: &mut HashMap<String, ActivePushToTalkGuard>,
        modifier_only_modifiers: handy_keys::Modifiers,
        event: &KeyEvent,
    ) {
        if event.key.is_some() {
            return;
        }

        for (binding_id, (hotkey, hotkey_string)) in modifier_only_bindings {
            match modifier_only_transition(
                *hotkey,
                event,
                modifier_only_modifiers,
                pressed_modifier_only.contains(binding_id),
            ) {
                Some(true) => {
                    if !modifier_only_tracker.modifier_only_press_is_fresh(*hotkey, Instant::now())
                    {
                        debug!(
                            "Suppressing handy-keys modifier-only press for '{}' because another modifier appears stale",
                            hotkey_string
                        );
                        continue;
                    }
                    pressed_modifier_only.insert(binding_id.clone());
                    Self::update_push_to_talk_guard(
                        app,
                        active_push_to_talk,
                        binding_id,
                        hotkey_string,
                        true,
                    );
                    debug!(
                        "handy-keys modifier-only event: binding={}, hotkey={}, state=Pressed",
                        binding_id, hotkey_string
                    );
                    handle_shortcut_event(app, binding_id, hotkey_string, true);
                }
                Some(false) => {
                    pressed_modifier_only.remove(binding_id);
                    active_push_to_talk.remove(binding_id);
                    debug!(
                        "handy-keys modifier-only event: binding={}, hotkey={}, state=Released",
                        binding_id, hotkey_string
                    );
                    handle_shortcut_event(app, binding_id, hotkey_string, false);
                }
                None => {}
            }
        }
    }

    fn update_push_to_talk_guard(
        app: &AppHandle,
        active_push_to_talk: &mut HashMap<String, ActivePushToTalkGuard>,
        binding_id: &str,
        hotkey_string: &str,
        is_pressed: bool,
    ) {
        if !should_track_push_to_talk_guard(app, binding_id) {
            active_push_to_talk.remove(binding_id);
            return;
        }

        if !is_pressed {
            active_push_to_talk.remove(binding_id);
            return;
        }

        let Ok(hotkey) = hotkey_string.parse::<Hotkey>() else {
            warn!(
                "Failed to parse push-to-talk hotkey '{}' for release guard",
                hotkey_string
            );
            active_push_to_talk.remove(binding_id);
            return;
        };

        active_push_to_talk.insert(
            binding_id.to_string(),
            ActivePushToTalkGuard {
                hotkey,
                hotkey_string: hotkey_string.to_string(),
            },
        );
    }

    fn dispatch_push_to_talk_release_guards(
        app: &AppHandle,
        active_push_to_talk: &mut HashMap<String, ActivePushToTalkGuard>,
        modifier_only_modifiers: handy_keys::Modifiers,
        event: &KeyEvent,
    ) {
        let mut released_bindings = Vec::new();

        for (binding_id, guard) in active_push_to_talk.iter() {
            if push_to_talk_guard_should_release(guard.hotkey, modifier_only_modifiers, event) {
                released_bindings.push((binding_id.clone(), guard.hotkey_string.to_string()));
            }
        }

        for (binding_id, hotkey_string) in released_bindings {
            active_push_to_talk.remove(&binding_id);
            debug!(
                "handy-keys push-to-talk release guard fired: binding={}, hotkey={}",
                binding_id, hotkey_string
            );
            handle_shortcut_event(app, &binding_id, &hotkey_string, false);
        }
    }

    /// Register a shortcut binding
    pub fn register(&self, binding: &ShortcutBinding) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.command_sender
            .lock()
            .map_err(|_| "Failed to lock command_sender")?
            .send(ManagerCommand::Register {
                binding_id: binding.id.clone(),
                hotkey_string: binding.current_binding.clone(),
                response: tx,
            })
            .map_err(|_| "Failed to send register command")?;

        rx.recv()
            .map_err(|_| "Failed to receive register response")?
    }

    /// Unregister a shortcut binding
    pub fn unregister(&self, binding: &ShortcutBinding) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.command_sender
            .lock()
            .map_err(|_| "Failed to lock command_sender")?
            .send(ManagerCommand::Unregister {
                binding_id: binding.id.clone(),
                response: tx,
            })
            .map_err(|_| "Failed to send unregister command")?;

        rx.recv()
            .map_err(|_| "Failed to receive unregister response")?
    }

    /// Start recording mode for a specific binding
    pub fn start_recording(&self, app: &AppHandle, binding_id: String) -> Result<(), String> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err("Already recording".into());
        }

        // Create a new keyboard listener for recording
        let listener = KeyboardListener::new()
            .map_err(|e| format!("Failed to create keyboard listener: {}", e))?;

        {
            let mut recording = self
                .recording_listener
                .lock()
                .map_err(|_| "Failed to lock recording_listener")?;
            *recording = Some(listener);
        }
        {
            let mut binding = self
                .recording_binding_id
                .lock()
                .map_err(|_| "Failed to lock recording_binding_id")?;
            *binding = Some(binding_id);
        }

        self.is_recording.store(true, Ordering::SeqCst);
        self.recording_running.store(true, Ordering::SeqCst);

        // Start a thread to emit key events to the frontend
        let app_clone = app.clone();
        let recording_running = Arc::clone(&self.recording_running);
        thread::spawn(move || {
            Self::recording_loop(app_clone, recording_running);
        });

        debug!("Started handy-keys recording mode");
        Ok(())
    }

    /// Recording loop - emits key events to frontend during recording
    fn recording_loop(app: AppHandle, running: Arc<AtomicBool>) {
        while running.load(Ordering::SeqCst) {
            let event = {
                let state = match app.try_state::<HandyKeysState>() {
                    Some(s) => s,
                    None => break,
                };
                let listener = state.recording_listener.lock().ok();
                listener.as_ref().and_then(|l| l.as_ref()?.try_recv())
            };

            if let Some(key_event) = event {
                // Convert to frontend-friendly format
                let frontend_event = FrontendKeyEvent {
                    modifiers: modifiers_to_strings(key_event.modifiers),
                    key: key_event.key.map(|k| k.to_string().to_lowercase()),
                    is_key_down: key_event.is_key_down,
                    hotkey_string: key_event
                        .as_hotkey()
                        .map(|h| h.to_handy_string())
                        .unwrap_or_default(),
                };

                // Emit to frontend
                if let Err(e) = app.emit("handy-keys-event", &frontend_event) {
                    error!("Failed to emit key event: {}", e);
                }
            } else {
                thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        debug!("Recording loop ended");
    }

    /// Stop recording mode
    pub fn stop_recording(&self) -> Result<(), String> {
        self.is_recording.store(false, Ordering::SeqCst);
        self.recording_running.store(false, Ordering::SeqCst);

        {
            let mut recording = self
                .recording_listener
                .lock()
                .map_err(|_| "Failed to lock recording_listener")?;
            *recording = None;
        }
        {
            let mut binding = self
                .recording_binding_id
                .lock()
                .map_err(|_| "Failed to lock recording_binding_id")?;
            *binding = None;
        }

        debug!("Stopped handy-keys recording mode");
        Ok(())
    }
}

impl Drop for HandyKeysState {
    fn drop(&mut self) {
        // Signal recording to stop
        self.recording_running.store(false, Ordering::SeqCst);
        self.is_recording.store(false, Ordering::SeqCst);

        // Send shutdown command
        if let Ok(sender) = self.command_sender.lock() {
            let _ = sender.send(ManagerCommand::Shutdown);
        }

        // Wait for the manager thread to finish
        if let Ok(mut handle) = self.thread_handle.lock() {
            if let Some(h) = handle.take() {
                let _ = h.join();
            }
        }
    }
}

/// Convert handy-keys Modifiers to a list of strings
fn modifiers_to_strings(modifiers: handy_keys::Modifiers) -> Vec<String> {
    let mut result = Vec::new();

    if modifiers.contains(handy_keys::Modifiers::CTRL) {
        result.push("ctrl".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::OPT) {
        #[cfg(target_os = "macos")]
        result.push("option".to_string());
        #[cfg(not(target_os = "macos"))]
        result.push("alt".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::SHIFT) {
        result.push("shift".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::CMD) {
        #[cfg(target_os = "macos")]
        result.push("command".to_string());
        #[cfg(not(target_os = "macos"))]
        result.push("super".to_string());
    }
    if modifiers.contains(handy_keys::Modifiers::FN) {
        result.push("fn".to_string());
    }

    result
}

fn modifier_family_signature(modifiers: handy_keys::Modifiers) -> [bool; 5] {
    [
        modifiers.intersects(
            handy_keys::Modifiers::CTRL
                | handy_keys::Modifiers::CTRL_LEFT
                | handy_keys::Modifiers::CTRL_RIGHT,
        ),
        modifiers.intersects(
            handy_keys::Modifiers::OPT
                | handy_keys::Modifiers::OPT_LEFT
                | handy_keys::Modifiers::OPT_RIGHT,
        ),
        modifiers.intersects(
            handy_keys::Modifiers::SHIFT
                | handy_keys::Modifiers::SHIFT_LEFT
                | handy_keys::Modifiers::SHIFT_RIGHT,
        ),
        modifiers.intersects(
            handy_keys::Modifiers::CMD
                | handy_keys::Modifiers::CMD_LEFT
                | handy_keys::Modifiers::CMD_RIGHT,
        ),
        modifiers.contains(handy_keys::Modifiers::FN),
    ]
}

fn modifier_family_count(modifiers: handy_keys::Modifiers) -> usize {
    modifier_family_signature(modifiers)
        .into_iter()
        .filter(|present| *present)
        .count()
}

fn modifier_family_index(modifiers: Option<handy_keys::Modifiers>) -> Option<usize> {
    let modifiers = modifiers?;

    if modifiers.intersects(
        handy_keys::Modifiers::CTRL
            | handy_keys::Modifiers::CTRL_LEFT
            | handy_keys::Modifiers::CTRL_RIGHT,
    ) {
        Some(0)
    } else if modifiers.intersects(
        handy_keys::Modifiers::OPT
            | handy_keys::Modifiers::OPT_LEFT
            | handy_keys::Modifiers::OPT_RIGHT,
    ) {
        Some(1)
    } else if modifiers.intersects(
        handy_keys::Modifiers::SHIFT
            | handy_keys::Modifiers::SHIFT_LEFT
            | handy_keys::Modifiers::SHIFT_RIGHT,
    ) {
        Some(2)
    } else if modifiers.intersects(
        handy_keys::Modifiers::CMD
            | handy_keys::Modifiers::CMD_LEFT
            | handy_keys::Modifiers::CMD_RIGHT,
    ) {
        Some(3)
    } else if modifiers.contains(handy_keys::Modifiers::FN) {
        Some(4)
    } else {
        None
    }
}

fn modifier_families_match_exact(
    expected: handy_keys::Modifiers,
    actual: handy_keys::Modifiers,
) -> bool {
    modifier_family_signature(expected) == modifier_family_signature(actual)
}

/// Validate a shortcut string for the HandyKeys implementation.
/// HandyKeys is more permissive: allows modifier-only combos and the fn key.
pub fn validate_shortcut(raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err("Shortcut cannot be empty".into());
    }

    let hotkey = raw
        .parse::<Hotkey>()
        .map_err(|e| format!("Invalid shortcut for HandyKeys: {}", e))?;

    if hotkey.key.is_none()
        && modifier_family_count(hotkey.modifiers) == 1
        && !hotkey.modifiers.contains(handy_keys::Modifiers::FN)
    {
        return Err("Modifier-only shortcuts must include Fn or at least two modifiers".into());
    }

    Ok(())
}

/// Initialize handy-keys shortcuts
pub fn init_shortcuts(app: &AppHandle) -> Result<(), String> {
    let state = HandyKeysState::new(app.clone())?;

    let default_bindings = settings::get_default_settings().bindings;
    let mut user_settings = settings::load_or_create_app_settings(app);
    let mut repaired_bindings = false;

    // Register all bindings except cancel (which is dynamic)
    for (id, default_binding) in default_bindings {
        if id == "cancel" {
            continue;
        }
        let mut binding = user_settings
            .bindings
            .get(&id)
            .cloned()
            .unwrap_or(default_binding.clone());

        if let Err(e) = validate_shortcut(&binding.current_binding) {
            warn!(
                "Shortcut '{}' ('{}') is invalid for handy-keys: {}. Resetting to default.",
                id, binding.current_binding, e
            );
            binding = default_binding.clone();
            user_settings.bindings.insert(id.clone(), binding.clone());
            repaired_bindings = true;
        }

        if let Err(e) = state.register(&binding) {
            error!(
                "Failed to register handy-keys shortcut {} during init: {}",
                id, e
            );
        }
    }

    if repaired_bindings {
        settings::write_settings(app, user_settings);
    }

    app.manage(state);
    info!("handy-keys shortcuts initialized");
    Ok(())
}

fn should_track_push_to_talk_guard(app: &AppHandle, binding_id: &str) -> bool {
    if !is_transcribe_binding(binding_id) {
        return false;
    }

    let settings = get_settings(app);
    transcribe_binding_push_to_talk(binding_id, settings.push_to_talk)
}

fn modifier_only_transition(
    hotkey: Hotkey,
    event: &KeyEvent,
    active_modifiers: handy_keys::Modifiers,
    was_active: bool,
) -> Option<bool> {
    if hotkey.key.is_some() || event.key.is_some() {
        return None;
    }

    let is_active = modifier_families_match_exact(hotkey.modifiers, active_modifiers);
    if !was_active && event.is_key_down && is_active {
        Some(true)
    } else if was_active && !event.is_key_down && !is_active {
        Some(false)
    } else {
        None
    }
}

fn push_to_talk_guard_should_release(
    hotkey: Hotkey,
    modifier_only_modifiers: handy_keys::Modifiers,
    event: &KeyEvent,
) -> bool {
    if hotkey.key.is_none() {
        return !modifier_families_match_exact(hotkey.modifiers, modifier_only_modifiers);
    }

    if !hotkey.modifiers.matches(event.modifiers) {
        return true;
    }

    hotkey.key == event.key && !event.is_key_down
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifier_only_transition_starts_fn_binding_on_press() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        assert_eq!(
            modifier_only_transition(hotkey, &event, event.modifiers, false),
            Some(true)
        );
    }

    #[test]
    fn modifier_only_transition_stops_fn_binding_on_release() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::empty(),
            key: None,
            is_key_down: false,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        assert_eq!(
            modifier_only_transition(hotkey, &event, event.modifiers, true),
            Some(false)
        );
    }

    #[test]
    fn modifier_only_transition_ignores_unrelated_modifier_press() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::SHIFT_LEFT,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::SHIFT_LEFT),
        };

        assert_eq!(
            modifier_only_transition(hotkey, &event, event.modifiers, false),
            None
        );
    }

    #[test]
    fn modifier_only_transition_requires_exact_modifier_match() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CMD_LEFT | handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        assert_eq!(
            modifier_only_transition(hotkey, &event, event.modifiers, false),
            None
        );
    }

    #[test]
    fn modifier_only_transition_accepts_exact_multi_modifier_combo() {
        let hotkey: Hotkey = "command+fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CMD_LEFT | handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        assert_eq!(
            modifier_only_transition(hotkey, &event, event.modifiers, false),
            Some(true)
        );
    }

    #[test]
    fn modifier_only_tracker_recovers_stale_command_before_fn_press() {
        let mut tracker = ModifierOnlyTracker::default();
        let now = Instant::now();
        tracker.active[3] = true;
        tracker.last_pressed_at[3] =
            Some(now - MODIFIER_ONLY_STALE_TIMEOUT - Duration::from_millis(1));

        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CMD_LEFT | handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        tracker.clear_stale_before_modifier_press(&event, now, true);
        tracker.apply(&event, now);

        assert_eq!(tracker.modifiers(), handy_keys::Modifiers::FN);
    }

    #[test]
    fn modifier_only_tracker_keeps_recent_command_for_command_fn_chord() {
        let mut tracker = ModifierOnlyTracker::default();
        let now = Instant::now();
        let hotkey: Hotkey = "command+fn".parse().unwrap();
        tracker.active[3] = true;
        tracker.last_pressed_at[3] = Some(now - Duration::from_millis(100));

        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CMD_LEFT | handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        tracker.clear_stale_before_modifier_press(&event, now, true);
        tracker.apply(&event, now);

        assert_eq!(
            tracker.modifiers(),
            handy_keys::Modifiers::CMD | handy_keys::Modifiers::FN
        );
        assert!(tracker.modifier_only_press_is_fresh(hotkey, now));
    }

    #[test]
    fn modifier_only_tracker_rejects_stale_multi_modifier_chord_press() {
        let mut tracker = ModifierOnlyTracker::default();
        let now = Instant::now();
        tracker.active[3] = true;
        tracker.last_pressed_at[3] =
            Some(now - MODIFIER_ONLY_CHORD_WINDOW - Duration::from_millis(1));

        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CMD_LEFT | handy_keys::Modifiers::FN,
            key: None,
            is_key_down: true,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        tracker.clear_stale_before_modifier_press(&event, now, true);
        tracker.apply(&event, now);

        let hotkey: Hotkey = "command+fn".parse().unwrap();
        assert!(!tracker.modifier_only_press_is_fresh(hotkey, now));
    }

    #[test]
    fn validate_shortcut_rejects_single_non_fn_modifier() {
        assert!(validate_shortcut("ctrl").is_err());
    }

    #[test]
    fn validate_shortcut_allows_fn_only_shortcut() {
        assert!(validate_shortcut("fn").is_ok());
    }

    #[test]
    fn push_to_talk_guard_releases_on_main_key_up() {
        let hotkey: Hotkey = "ctrl+space".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CTRL,
            key: hotkey.key,
            is_key_down: false,
            changed_modifier: None,
        };

        assert!(push_to_talk_guard_should_release(
            hotkey,
            handy_keys::Modifiers::empty(),
            &event
        ));
    }

    #[test]
    fn push_to_talk_guard_releases_when_required_modifier_is_lost() {
        let hotkey: Hotkey = "ctrl+space".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::empty(),
            key: None,
            is_key_down: false,
            changed_modifier: Some(handy_keys::Modifiers::CTRL),
        };

        assert!(push_to_talk_guard_should_release(
            hotkey,
            handy_keys::Modifiers::empty(),
            &event
        ));
    }

    #[test]
    fn push_to_talk_guard_ignores_unrelated_key_activity_while_combo_is_held() {
        let hotkey: Hotkey = "ctrl+space".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::CTRL,
            key: "a".parse().ok(),
            is_key_down: true,
            changed_modifier: None,
        };

        assert!(!push_to_talk_guard_should_release(
            hotkey,
            handy_keys::Modifiers::empty(),
            &event
        ));
    }

    #[test]
    fn modifier_only_push_to_talk_guard_uses_tracked_modifier_state() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::empty(),
            key: None,
            is_key_down: false,
            changed_modifier: None,
        };

        assert!(!push_to_talk_guard_should_release(
            hotkey,
            handy_keys::Modifiers::FN,
            &event
        ));
    }

    #[test]
    fn modifier_only_push_to_talk_guard_releases_when_tracked_state_clears() {
        let hotkey: Hotkey = "fn".parse().unwrap();
        let event = KeyEvent {
            modifiers: handy_keys::Modifiers::empty(),
            key: None,
            is_key_down: false,
            changed_modifier: Some(handy_keys::Modifiers::FN),
        };

        assert!(push_to_talk_guard_should_release(
            hotkey,
            handy_keys::Modifiers::empty(),
            &event
        ));
    }
}

/// Register the cancel shortcut (called when recording starts)
pub fn register_cancel_shortcut(app: &AppHandle) {
    // Disabled on Linux due to instability
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                if let Some(state) = app_clone.try_state::<HandyKeysState>() {
                    if let Err(e) = state.register(&cancel_binding) {
                        error!("Failed to register cancel shortcut: {}", e);
                    }
                }
            }
        });
    }
}

/// Unregister the cancel shortcut (called when recording stops)
pub fn unregister_cancel_shortcut(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(cancel_binding) = get_settings(&app_clone).bindings.get("cancel").cloned() {
                if let Some(state) = app_clone.try_state::<HandyKeysState>() {
                    let _ = state.unregister(&cancel_binding);
                }
            }
        });
    }
}

/// Register a shortcut
pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.register(&binding)
}

/// Unregister a shortcut
pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.unregister(&binding)
}

/// Start key recording mode
#[tauri::command]
#[specta::specta]
pub fn start_handy_keys_recording(app: AppHandle, binding_id: String) -> Result<(), String> {
    let settings = get_settings(&app);
    if settings.keyboard_implementation != settings::KeyboardImplementation::HandyKeys {
        return Err("handy-keys is not the active keyboard implementation".into());
    }

    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.start_recording(&app, binding_id)
}

/// Stop key recording mode
#[tauri::command]
#[specta::specta]
pub fn stop_handy_keys_recording(app: AppHandle) -> Result<(), String> {
    let settings = get_settings(&app);
    if settings.keyboard_implementation != settings::KeyboardImplementation::HandyKeys {
        return Err("handy-keys is not the active keyboard implementation".into());
    }

    let state = app
        .try_state::<HandyKeysState>()
        .ok_or("HandyKeysState not initialized")?;
    state.stop_recording()
}
