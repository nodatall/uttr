use crate::audio_toolkit::{
    import_audio_file, list_input_devices, vad::SmoothedVad, AudioRecorder, DrainResult, SileroVad,
};
use crate::helpers::clamshell;
use crate::settings::{get_settings, AppSettings};
use crate::utils;
use log::{debug, error, info, warn};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::Manager;

static FIRST_AUDIO_LEVEL_LOGGED: AtomicBool = AtomicBool::new(true);
const MICROPHONE_RECOVERY_POLL_INTERVAL: Duration = Duration::from_millis(500);
const MICROPHONE_RECOVERY_RETRY_DELAY: Duration = Duration::from_secs(5);
const MICROPHONE_DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

fn set_mute(mute: bool) {
    // Expected behavior:
    // - Windows: works on most systems using standard audio drivers.
    // - Linux: works on many systems (PipeWire, PulseAudio, ALSA),
    //   but some distros may lack the tools used.
    // - macOS: works on most standard setups via AppleScript.
    // If unsupported, fails silently.

    #[cfg(target_os = "windows")]
    {
        unsafe {
            use windows::Win32::{
                Media::Audio::{
                    eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
                    MMDeviceEnumerator,
                },
                System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
            };

            macro_rules! unwrap_or_return {
                ($expr:expr) => {
                    match $expr {
                        Ok(val) => val,
                        Err(_) => return,
                    }
                };
            }

            // Initialize the COM library for this thread.
            // If already initialized (e.g., by another library like Tauri), this does nothing.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let all_devices: IMMDeviceEnumerator =
                unwrap_or_return!(CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL));
            let default_device =
                unwrap_or_return!(all_devices.GetDefaultAudioEndpoint(eRender, eMultimedia));
            let volume_interface = unwrap_or_return!(
                default_device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            );

            let _ = volume_interface.SetMute(mute, std::ptr::null());
        }
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;

        let mute_val = if mute { "1" } else { "0" };
        let amixer_state = if mute { "mute" } else { "unmute" };

        // Try multiple backends to increase compatibility
        // 1. PipeWire (wpctl)
        if Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_AUDIO_SINK@", mute_val])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return;
        }

        // 2. PulseAudio (pactl)
        if Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", mute_val])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return;
        }

        // 3. ALSA (amixer)
        let _ = Command::new("amixer")
            .args(["set", "Master", amixer_state])
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let script = format!(
            "set volume output muted {}",
            if mute { "true" } else { "false" }
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }
}

const WHISPER_SAMPLE_RATE: usize = 16000;

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone, Debug)]
pub enum RecordingState {
    Idle,
    Recording { binding_id: String },
}

#[derive(Clone, Debug)]
pub enum MicrophoneMode {
    AlwaysOn,
    OnDemand,
}

/* ──────────────────────────────────────────────────────────────── */

fn create_audio_recorder(
    vad_path: &str,
    app_handle: &tauri::AppHandle,
) -> Result<AudioRecorder, anyhow::Error> {
    let silero = SileroVad::new(vad_path, 0.22)
        .map_err(|e| anyhow::anyhow!("Failed to create SileroVad: {}", e))?;
    // Less aggressive onset gating helps preserve first spoken words.
    // Keep generous prefill to include context leading into the first detected voice frame.
    let smoothed_vad = SmoothedVad::new(Box::new(silero), 24, 12, 1);

    // Recorder with VAD plus a spectrum-level callback that forwards updates to
    // the frontend.
    let recorder = AudioRecorder::new()
        .map_err(|e| anyhow::anyhow!("Failed to create AudioRecorder: {}", e))?
        .with_vad(Box::new(smoothed_vad))
        .with_level_callback({
            let app_handle = app_handle.clone();
            move |levels| {
                if !levels.is_empty() && !FIRST_AUDIO_LEVEL_LOGGED.swap(true, Ordering::Relaxed) {
                    info!(
                        "[latency] first audio level callback received band_count={}",
                        levels.len()
                    );
                }
                utils::emit_levels(&app_handle, &levels);
            }
        });

    Ok(recorder)
}

fn release_smoke_audio_file() -> Option<PathBuf> {
    let smoke_enabled = std::env::var("UTTR_RELEASE_SMOKE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false);
    if !smoke_enabled {
        return None;
    }

    std::env::var_os("UTTR_RELEASE_SMOKE_AUDIO_FILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/* ──────────────────────────────────────────────────────────────── */

#[derive(Clone)]
pub struct AudioRecordingManager {
    lifecycle: Arc<Mutex<()>>,
    recovery_enabled: Arc<AtomicBool>,
    state: Arc<Mutex<RecordingState>>,
    mode: Arc<Mutex<MicrophoneMode>>,
    app_handle: tauri::AppHandle,

    recorder: Arc<Mutex<Option<AudioRecorder>>>,
    is_open: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    recording_started_at: Arc<Mutex<Option<Instant>>>,
    did_mute: Arc<Mutex<bool>>,
}

impl AudioRecordingManager {
    /* ---------- construction ------------------------------------------------ */

    pub fn new(app: &tauri::AppHandle) -> Result<Self, anyhow::Error> {
        let settings = get_settings(app);
        let mode = if settings.always_on_microphone {
            MicrophoneMode::AlwaysOn
        } else {
            MicrophoneMode::OnDemand
        };

        let manager = Self {
            lifecycle: Arc::new(Mutex::new(())),
            recovery_enabled: Arc::new(AtomicBool::new(true)),
            state: Arc::new(Mutex::new(RecordingState::Idle)),
            mode: Arc::new(Mutex::new(mode.clone())),
            app_handle: app.clone(),

            recorder: Arc::new(Mutex::new(None)),
            is_open: Arc::new(Mutex::new(false)),
            is_recording: Arc::new(Mutex::new(false)),
            recording_started_at: Arc::new(Mutex::new(None)),
            did_mute: Arc::new(Mutex::new(false)),
        };

        // Always-on?  Open immediately.
        if matches!(mode, MicrophoneMode::AlwaysOn) {
            if let Err(err) = manager.start_microphone_stream() {
                warn!(
                    "Failed to initialize always-on microphone stream; will retry in the background: {err}"
                );
            }
        }

        Ok(manager)
    }

    pub fn start_recovery_monitor(self: &Arc<Self>) {
        let manager = Arc::downgrade(self);
        std::thread::spawn(move || {
            let mut last_device_check = None;
            monitor_microphone_recovery(
                || {
                    let manager = manager.upgrade()?;
                    if !manager.recovery_enabled.load(Ordering::Acquire) {
                        return None;
                    }
                    Some(manager.recover_microphone_stream(&mut last_device_check))
                },
                MICROPHONE_RECOVERY_POLL_INTERVAL,
                MICROPHONE_RECOVERY_RETRY_DELAY,
            );
        });
    }

    pub fn shutdown(&self) {
        self.recovery_enabled.store(false, Ordering::Release);
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.stop_microphone_stream_locked();
    }

    fn recover_microphone_stream(
        &self,
        last_device_check: &mut Option<Instant>,
    ) -> Result<(), anyhow::Error> {
        if release_smoke_audio_file().is_some() {
            return Ok(());
        }
        recover_idle_always_on_microphone(
            &self.lifecycle,
            &self.recovery_enabled,
            &self.mode,
            &self.state,
            || {
                let stream_failed = !*self.is_open.lock().unwrap()
                    || self
                        .recorder
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_none_or(AudioRecorder::has_stream_failed);
                stream_failed
                    || (microphone_device_check_due(last_device_check, Instant::now())
                        && self.should_restore_preferred_microphone())
            },
            || {
                let started = Instant::now();
                info!("Recovering always-on microphone stream in the background");
                self.stop_microphone_stream_locked();
                self.start_microphone_stream_locked()?;
                info!(
                    "Always-on microphone stream recovered in {}ms",
                    started.elapsed().as_millis()
                );
                Ok(())
            },
        )
    }

    /* ---------- helper methods --------------------------------------------- */

    fn get_effective_microphone_name<'a>(&self, settings: &'a AppSettings) -> Option<&'a str> {
        // Check if we're in clamshell mode and have a clamshell microphone configured
        let use_clamshell_mic =
            settings.clamshell_microphone.is_some() && clamshell::is_clamshell().unwrap_or(false);

        if use_clamshell_mic {
            settings.clamshell_microphone.as_deref()
        } else {
            settings.selected_microphone.as_deref()
        }
    }

    fn get_effective_microphone_device(&self, settings: &AppSettings) -> Option<cpal::Device> {
        let device_name = self.get_effective_microphone_name(settings)?;

        // Find the device by name
        match list_input_devices() {
            Ok(devices) => devices
                .into_iter()
                .find(|d| d.name == device_name)
                .map(|d| d.device),
            Err(e) => {
                debug!("Failed to list devices, using default: {}", e);
                None
            }
        }
    }

    fn should_restore_preferred_microphone(&self) -> bool {
        if release_smoke_audio_file().is_some() {
            return false;
        }
        let settings = get_settings(&self.app_handle);
        let preferred_name = self.get_effective_microphone_name(&settings);
        let active_name = self
            .recorder
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|recorder| recorder.input_device_name().map(str::to_owned));

        preferred_microphone_needs_restore(preferred_name, active_name.as_deref(), |name| {
            match list_input_devices() {
                Ok(devices) if devices.iter().any(|device| device.name == name) => {
                    info!(
                        "Preferred microphone '{}' is available again; replacing fallback input {:?}",
                        name, active_name
                    );
                    true
                }
                Ok(_) => false,
                Err(err) => {
                    debug!("Failed to check preferred microphone availability: {err}");
                    false
                }
            }
        })
    }

    /* ---------- microphone life-cycle -------------------------------------- */

    /// Applies mute if mute_while_recording is enabled and stream is open
    pub fn apply_mute(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let settings = get_settings(&self.app_handle);
        let mut did_mute_guard = self.did_mute.lock().unwrap();

        if settings.mute_while_recording
            && *self.is_open.lock().unwrap()
            && *self.is_recording.lock().unwrap()
        {
            set_mute(true);
            *did_mute_guard = true;
            debug!("Mute applied");
        }
    }

    /// Removes mute if it was applied
    pub fn remove_mute(&self) {
        let mut did_mute_guard = self.did_mute.lock().unwrap();
        if *did_mute_guard {
            set_mute(false);
            *did_mute_guard = false;
            debug!("Mute removed");
        }
    }

    pub fn start_microphone_stream(&self) -> Result<(), anyhow::Error> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.start_microphone_stream_locked()
    }

    // Callers hold lifecycle across stream transitions and recording state changes.
    fn start_microphone_stream_locked(&self) -> Result<(), anyhow::Error> {
        let mut open_flag = self.is_open.lock().unwrap();
        if *open_flag {
            debug!("Microphone stream already active");
            return Ok(());
        }

        let start_time = Instant::now();

        // Don't mute immediately - caller will handle muting after audio feedback
        let mut did_mute_guard = self.did_mute.lock().unwrap();
        *did_mute_guard = false;

        if let Some(audio_file) = release_smoke_audio_file() {
            info!(
                "Release smoke microphone using synthetic audio file: {}",
                audio_file.display()
            );
            *open_flag = true;
            return Ok(());
        }

        let vad_path = self
            .app_handle
            .path()
            .resolve(
                "resources/models/silero_vad_v4.onnx",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| anyhow::anyhow!("Failed to resolve VAD path: {}", e))?;
        let mut recorder_opt = self.recorder.lock().unwrap();

        if recorder_opt.is_none() {
            *recorder_opt = Some(create_audio_recorder(
                vad_path.to_str().unwrap(),
                &self.app_handle,
            )?);
        }

        // Get the selected device from settings, considering clamshell mode
        let settings = get_settings(&self.app_handle);
        let selected_device = self.get_effective_microphone_device(&settings);

        if let Some(rec) = recorder_opt.as_mut() {
            rec.open(selected_device)
                .map_err(|e| anyhow::anyhow!("Failed to open recorder: {}", e))?;
        }

        *open_flag = true;
        info!(
            "Microphone stream initialized in {:?}",
            start_time.elapsed()
        );
        Ok(())
    }

    fn stop_microphone_stream_locked(&self) {
        {
            let mut open_flag = self.is_open.lock().unwrap();
            if !*open_flag {
                return;
            }
            *open_flag = false;
        }

        {
            let mut did_mute_guard = self.did_mute.lock().unwrap();
            if *did_mute_guard {
                set_mute(false);
            }
            *did_mute_guard = false;
        }

        let was_recording = {
            let mut guard = self.is_recording.lock().unwrap();
            let was_recording = *guard;
            *guard = false;
            was_recording
        };

        let recorder = self.recorder.lock().unwrap().take();
        debug!("Microphone stream stopping");

        if let Some(mut rec) = recorder {
            std::thread::spawn(move || {
                if was_recording {
                    let _ = rec.stop();
                }
                if let Err(err) = rec.close() {
                    error!("Failed to close microphone stream: {err}");
                }
            });
        }

        debug!("Microphone stream stopped");
    }

    pub fn is_microphone_open(&self) -> bool {
        *self.is_open.lock().unwrap()
    }

    fn close_on_demand_stream(&self) {
        if matches!(*self.mode.lock().unwrap(), MicrophoneMode::OnDemand) {
            self.stop_microphone_stream_locked();
        }
    }

    /* ---------- mode switching --------------------------------------------- */

    pub fn update_mode(&self, new_mode: MicrophoneMode) -> Result<(), anyhow::Error> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        update_microphone_mode(&self.mode, new_mode, |cur_mode, new_mode| {
            match (cur_mode, new_mode) {
                (MicrophoneMode::AlwaysOn, MicrophoneMode::OnDemand) => {
                    if matches!(*self.state.lock().unwrap(), RecordingState::Idle) {
                        self.stop_microphone_stream_locked();
                    }
                    Ok(())
                }
                (MicrophoneMode::OnDemand, MicrophoneMode::AlwaysOn) => {
                    self.start_microphone_stream_locked()
                }
                _ => Ok(()),
            }
        })
    }

    /* ---------- recording --------------------------------------------------- */

    fn start_recorder_command(&self) -> Result<(), String> {
        if release_smoke_audio_file().is_some() {
            return Ok(());
        }

        let recorder_guard = self.recorder.lock().unwrap();
        let rec = recorder_guard
            .as_ref()
            .ok_or_else(|| "Recorder not available".to_string())?;
        rec.start()
            .map_err(|err| format!("Failed to send recorder start command: {err}"))
    }

    pub fn try_start_recording(&self, binding_id: &str) -> bool {
        let start_time = Instant::now();
        let _lifecycle = self.lifecycle.lock().unwrap();

        if !matches!(*self.state.lock().unwrap(), RecordingState::Idle) {
            info!(
                "[latency] audio start skipped binding={} reason=busy elapsed_ms={}",
                binding_id,
                start_time.elapsed().as_millis()
            );
            false
        } else {
            // A preferred microphone may have reconnected between monitor ticks.
            // Restore it before recording begins, while the lifecycle is idle.
            if self.should_restore_preferred_microphone() {
                self.stop_microphone_stream_locked();
                if let Err(e) = self.start_microphone_stream_locked() {
                    error!("Failed to restore preferred microphone stream: {e}");
                    return false;
                }
            }

            // Ensure microphone is open in on-demand mode
            if matches!(*self.mode.lock().unwrap(), MicrophoneMode::OnDemand) {
                if let Err(e) = self.start_microphone_stream_locked() {
                    error!("Failed to open microphone stream: {e}");
                    return false;
                }
            }

            FIRST_AUDIO_LEVEL_LOGGED.store(false, Ordering::Relaxed);
            let start_result = self.start_recorder_command().or_else(|err| {
                warn!("Recorder start failed; restarting microphone stream: {err}");
                self.stop_microphone_stream_locked();
                self.start_microphone_stream_locked()
                    .map_err(|restart_err| restart_err.to_string())?;
                self.start_recorder_command()
            });

            if let Err(err) = start_result {
                error!("Recorder not available: {err}");
                return false;
            }

            *self.is_recording.lock().unwrap() = true;
            *self.recording_started_at.lock().unwrap() = Some(Instant::now());
            *self.state.lock().unwrap() = RecordingState::Recording {
                binding_id: binding_id.to_string(),
            };
            debug!("Recording started for binding {binding_id}");
            info!(
                "[latency] audio recording active binding={} elapsed_ms={}",
                binding_id,
                start_time.elapsed().as_millis()
            );
            true
        }
    }

    pub fn update_selected_device(&self) -> Result<(), anyhow::Error> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        // If currently open, restart the microphone stream to use the new device
        if *self.is_open.lock().unwrap() {
            self.stop_microphone_stream_locked();
            self.start_microphone_stream_locked()?;
        }
        Ok(())
    }

    pub fn stop_recording(&self, binding_id: &str) -> Option<Vec<f32>> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();

        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == binding_id => {
                *state = RecordingState::Idle;
                drop(state);

                let (samples, should_reset_stream) =
                    if let Some(audio_file) = release_smoke_audio_file() {
                        match import_audio_file(&audio_file) {
                            Ok(imported) => {
                                info!(
                                    "Release smoke microphone loaded {} samples from {}",
                                    imported.samples.len(),
                                    imported.path.display()
                                );
                                (imported.samples, false)
                            }
                            Err(err) => {
                                error!(
                                    "Failed to load release smoke microphone audio from {}: {err}",
                                    audio_file.display()
                                );
                                (Vec::new(), false)
                            }
                        }
                    } else {
                        let recorder_guard = self.recorder.lock().unwrap();
                        if let Some(rec) = recorder_guard.as_ref() {
                            match rec.stop() {
                                Ok(buf) => (buf, false),
                                Err(e) => {
                                    error!("stop() failed: {e}");
                                    (Vec::new(), true)
                                }
                            }
                        } else {
                            error!("Recorder not available");
                            (Vec::new(), true)
                        }
                    };

                *self.is_recording.lock().unwrap() = false;
                *self.recording_started_at.lock().unwrap() = None;

                if should_reset_stream {
                    self.stop_microphone_stream_locked();
                } else {
                    self.close_on_demand_stream();
                }

                Some(pad_short_recording_samples(samples))
            }
            _ => None,
        }
    }

    pub fn borrow_recording_binding_with_boundary(
        &self,
        from_binding_id: &str,
        to_binding_id: &str,
    ) -> bool {
        if !self.is_recording_binding(from_binding_id) {
            return false;
        }

        // Clear any audio captured for the previous owner so the borrowed
        // recording starts from a fresh sample boundary.
        let Some(boundary) = self.drain_recording_delta(from_binding_id) else {
            warn!(
                "Unable to borrow recording from '{}' to '{}' because the sample boundary drain failed",
                from_binding_id, to_binding_id
            );
            return false;
        };
        let drained_sample_count = boundary.samples.len();

        let mut state = self.state.lock().unwrap();
        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == from_binding_id => {
                *state = RecordingState::Recording {
                    binding_id: to_binding_id.to_string(),
                };
                *self.recording_started_at.lock().unwrap() = Some(Instant::now());
                info!(
                    "Borrowed active recording binding from '{}' to '{}' after draining {} sample(s)",
                    from_binding_id, to_binding_id, drained_sample_count
                );
                true
            }
            _ => false,
        }
    }

    pub fn finish_borrowed_recording_and_restore(
        &self,
        borrowed_binding_id: &str,
        restore_binding_id: &str,
    ) -> Option<Vec<f32>> {
        let is_borrowed_recording = self.is_recording_binding(borrowed_binding_id);
        if !is_borrowed_recording {
            return None;
        }

        let samples = self
            .drain_recording_delta(borrowed_binding_id)
            .map(|delta| delta.samples)
            .unwrap_or_default();

        let mut state = self.state.lock().unwrap();
        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == borrowed_binding_id => {
                *state = RecordingState::Recording {
                    binding_id: restore_binding_id.to_string(),
                };
                *self.recording_started_at.lock().unwrap() = Some(Instant::now());
                *self.is_recording.lock().unwrap() = true;
                info!(
                    "Finished borrowed recording '{}' and restored microphone binding '{}'",
                    borrowed_binding_id, restore_binding_id
                );
                Some(pad_short_recording_samples(samples))
            }
            _ => None,
        }
    }

    pub fn transfer_recording_binding(&self, from_binding_id: &str, to_binding_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == from_binding_id => {
                *state = RecordingState::Recording {
                    binding_id: to_binding_id.to_string(),
                };
                info!(
                    "Transferred active recording binding from '{}' to '{}'",
                    from_binding_id, to_binding_id
                );
                warn!(
                    "[ask-hotkey] audio_transfer from={} to={}",
                    from_binding_id, to_binding_id
                );
                true
            }
            _ => false,
        }
    }

    pub fn is_recording(&self) -> bool {
        matches!(
            *self.state.lock().unwrap(),
            RecordingState::Recording { .. }
        )
    }

    pub fn current_recording_duration(&self, binding_id: &str) -> Option<Duration> {
        let state = self.state.lock().unwrap();
        let matches_binding = matches!(
            *state,
            RecordingState::Recording {
                binding_id: ref active
            } if active == binding_id
        );
        drop(state);

        if !matches_binding {
            return None;
        }

        self.recording_started_at
            .lock()
            .unwrap()
            .as_ref()
            .map(Instant::elapsed)
    }

    pub fn current_recording_started_at(&self, binding_id: &str) -> Option<Instant> {
        let state = self.state.lock().unwrap();
        let matches_binding = matches!(
            *state,
            RecordingState::Recording {
                binding_id: ref active
            } if active == binding_id
        );
        drop(state);

        if !matches_binding {
            return None;
        }

        *self.recording_started_at.lock().unwrap()
    }

    pub fn is_recording_binding(&self, binding_id: &str) -> bool {
        matches!(
            *self.state.lock().unwrap(),
            RecordingState::Recording {
                binding_id: ref active
            } if active == binding_id
        )
    }

    pub fn drain_recording_delta(&self, binding_id: &str) -> Option<DrainResult> {
        let state = self.state.lock().unwrap();
        match *state {
            RecordingState::Recording {
                binding_id: ref active,
            } if active == binding_id => {
                drop(state);
                let recorder_guard = match self.recorder.try_lock() {
                    Ok(guard) => guard,
                    Err(_) => {
                        // Avoid blocking stop() waiting on recorder lock.
                        return None;
                    }
                };
                if let Some(rec) = recorder_guard.as_ref() {
                    match rec.drain() {
                        Ok(delta) => Some(delta),
                        Err(e) => {
                            if e.to_string()
                                .contains("Timed out waiting for drain response")
                            {
                                debug!("drain() timed out waiting for recorder response");
                            } else {
                                error!("drain() failed: {e}");
                            }
                            None
                        }
                    }
                } else {
                    error!("Recorder not available");
                    None
                }
            }
            _ => None,
        }
    }

    /// Cancel any ongoing recording without returning audio samples
    pub fn cancel_recording(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let mut state = self.state.lock().unwrap();

        if let RecordingState::Recording { .. } = *state {
            *state = RecordingState::Idle;
            drop(state);

            if let Some(rec) = self.recorder.lock().unwrap().as_ref() {
                let _ = rec.stop(); // Discard the result
            }

            *self.is_recording.lock().unwrap() = false;
            *self.recording_started_at.lock().unwrap() = None;

            self.close_on_demand_stream();
        }
    }
}

fn preferred_microphone_needs_restore(
    preferred_name: Option<&str>,
    active_name: Option<&str>,
    is_available: impl FnOnce(&str) -> bool,
) -> bool {
    let Some(preferred_name) = preferred_name else {
        return false;
    };
    active_name.is_some() && active_name != Some(preferred_name) && is_available(preferred_name)
}

fn microphone_device_check_due(last_check: &mut Option<Instant>, now: Instant) -> bool {
    if last_check.is_some_and(|last| now.duration_since(last) < MICROPHONE_DEVICE_CHECK_INTERVAL) {
        return false;
    }
    *last_check = Some(now);
    true
}

fn recover_idle_always_on_microphone(
    lifecycle: &Mutex<()>,
    recovery_enabled: &AtomicBool,
    mode: &Mutex<MicrophoneMode>,
    state: &Mutex<RecordingState>,
    needs_recovery: impl FnOnce() -> bool,
    reopen: impl FnOnce() -> Result<(), anyhow::Error>,
) -> Result<(), anyhow::Error> {
    // Do not queue behind a recording start/stop or device/mode change. The next
    // monitor tick can check again without interfering with the user's action.
    let Ok(_lifecycle) = lifecycle.try_lock() else {
        return Ok(());
    };
    if !recovery_enabled.load(Ordering::Acquire)
        || !matches!(*mode.lock().unwrap(), MicrophoneMode::AlwaysOn)
        || !matches!(*state.lock().unwrap(), RecordingState::Idle)
        || !needs_recovery()
    {
        return Ok(());
    }
    reopen()
}

fn monitor_microphone_recovery(
    mut recover: impl FnMut() -> Option<Result<(), anyhow::Error>>,
    poll_interval: Duration,
    retry_delay: Duration,
) {
    loop {
        let delay = match recover() {
            None => return,
            Some(Ok(())) => poll_interval,
            Some(Err(err)) => {
                warn!("Always-on microphone recovery failed; will retry: {err}");
                retry_delay
            }
        };
        std::thread::sleep(delay);
    }
}

fn update_microphone_mode(
    mode: &Mutex<MicrophoneMode>,
    new_mode: MicrophoneMode,
    transition: impl FnOnce(MicrophoneMode, &MicrophoneMode) -> Result<(), anyhow::Error>,
) -> Result<(), anyhow::Error> {
    // Stream transitions may need this mutex too. Release the snapshot lock
    // before transitioning or acquiring it again to commit the new mode.
    let current_mode = mode.lock().unwrap().clone();
    transition(current_mode, &new_mode)?;
    *mode.lock().unwrap() = new_mode;
    Ok(())
}

fn pad_short_recording_samples(samples: Vec<f32>) -> Vec<f32> {
    let s_len = samples.len();
    if s_len < WHISPER_SAMPLE_RATE && s_len > 0 {
        let mut padded = samples;
        padded.resize(WHISPER_SAMPLE_RATE * 5 / 4, 0.0);
        padded
    } else {
        samples
    }
}

#[cfg(test)]
mod tests {
    use super::{
        microphone_device_check_due, monitor_microphone_recovery, pad_short_recording_samples,
        preferred_microphone_needs_restore, recover_idle_always_on_microphone,
        update_microphone_mode, MicrophoneMode, RecordingState, MICROPHONE_DEVICE_CHECK_INTERVAL,
        WHISPER_SAMPLE_RATE,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn preferred_microphone_restoration_only_checks_a_different_active_input() {
        for (preferred, active) in [
            (None, Some("MacBook Pro Microphone")),
            (Some("DJI MIC MINI"), None),
            (Some("DJI MIC MINI"), Some("DJI MIC MINI")),
        ] {
            assert!(!preferred_microphone_needs_restore(
                preferred,
                active,
                |_| {
                    panic!("default, closed, and matching inputs do not need device enumeration")
                }
            ));
        }

        for available in [false, true] {
            assert_eq!(
                preferred_microphone_needs_restore(
                    Some("DJI MIC MINI"),
                    Some("MacBook Pro Microphone"),
                    |name| {
                        assert_eq!(name, "DJI MIC MINI");
                        available
                    },
                ),
                available,
                "keep the fallback until the selected microphone is available"
            );
        }
    }

    #[test]
    fn background_monitor_restores_reconnected_microphone_after_recording_ends() {
        let lifecycle = Mutex::new(());
        let enabled = AtomicBool::new(true);
        let mode = Mutex::new(MicrophoneMode::AlwaysOn);
        let state = Mutex::new(RecordingState::Idle);
        let active_name = Mutex::new("MacBook Pro Microphone".to_string());
        let available = AtomicBool::new(false);
        let mut reopens = 0;
        let mut ticks = 0;

        monitor_microphone_recovery(
            || {
                ticks += 1;
                match ticks {
                    2 => {
                        available.store(true, Ordering::Release);
                        *state.lock().unwrap() = RecordingState::Recording {
                            binding_id: "transcribe".to_string(),
                        };
                    }
                    3 => *state.lock().unwrap() = RecordingState::Idle,
                    5 => return None,
                    _ => {}
                }
                Some(recover_idle_always_on_microphone(
                    &lifecycle,
                    &enabled,
                    &mode,
                    &state,
                    || {
                        preferred_microphone_needs_restore(
                            Some("DJI MIC MINI"),
                            Some(active_name.lock().unwrap().as_str()),
                            |_| available.load(Ordering::Acquire),
                        )
                    },
                    || {
                        assert_eq!(ticks, 3, "never replace an active recording");
                        reopens += 1;
                        *active_name.lock().unwrap() = "DJI MIC MINI".to_string();
                        Ok(())
                    },
                ))
            },
            Duration::ZERO,
            Duration::ZERO,
        );

        assert_eq!(reopens, 1, "the restored input must not reopen again");
        assert_eq!(active_name.lock().unwrap().as_str(), "DJI MIC MINI");
    }

    #[test]
    fn microphone_device_enumeration_is_throttled_independently_of_health_checks() {
        let now = Instant::now();
        let mut last_check = None;
        assert!(microphone_device_check_due(&mut last_check, now));
        assert!(!microphone_device_check_due(
            &mut last_check,
            now + MICROPHONE_DEVICE_CHECK_INTERVAL - Duration::from_millis(1),
        ));
        assert_eq!(last_check, Some(now));
        assert!(microphone_device_check_due(
            &mut last_check,
            now + MICROPHONE_DEVICE_CHECK_INTERVAL,
        ));
    }

    #[test]
    fn background_monitor_recovers_and_retries_without_a_recording_action() {
        let lifecycle = Mutex::new(());
        let enabled = AtomicBool::new(true);
        let mode = Mutex::new(MicrophoneMode::AlwaysOn);
        let state = Mutex::new(RecordingState::Idle);
        // A failed stream is still marked open, just as it is after the device
        // error callback. The first reopen fails while the device is unavailable.
        let open = AtomicBool::new(true);
        let failed = AtomicBool::new(true);
        let mut attempts = 0;
        let mut ticks = 0;

        monitor_microphone_recovery(
            || {
                ticks += 1;
                if ticks == 4 {
                    return None;
                }
                Some(recover_idle_always_on_microphone(
                    &lifecycle,
                    &enabled,
                    &mode,
                    &state,
                    || !open.load(Ordering::Acquire) || failed.load(Ordering::Acquire),
                    || {
                        attempts += 1;
                        open.store(false, Ordering::Release);
                        failed.store(false, Ordering::Release);
                        if attempts == 1 {
                            return Err(anyhow::anyhow!("device unavailable"));
                        }
                        open.store(true, Ordering::Release);
                        Ok(())
                    },
                ))
            },
            Duration::ZERO,
            Duration::ZERO,
        );

        assert_eq!(
            attempts, 2,
            "closed streams must retry, healthy streams must not"
        );
        assert!(open.load(Ordering::Acquire));
        assert!(!failed.load(Ordering::Acquire));
        assert!(matches!(*state.lock().unwrap(), RecordingState::Idle));
    }

    #[test]
    fn background_recovery_respects_mode_recording_and_shutdown() {
        let lifecycle = Mutex::new(());
        let enabled = AtomicBool::new(true);
        let mode = Mutex::new(MicrophoneMode::OnDemand);
        let state = Mutex::new(RecordingState::Idle);
        let mut reopen_count = 0;
        let mut tick = || {
            recover_idle_always_on_microphone(
                &lifecycle,
                &enabled,
                &mode,
                &state,
                || true,
                || {
                    reopen_count += 1;
                    Ok(())
                },
            )
            .unwrap();
        };

        tick(); // On-demand streams stay closed until requested.
        *mode.lock().unwrap() = MicrophoneMode::AlwaysOn;
        *state.lock().unwrap() = RecordingState::Recording {
            binding_id: "record_full_system_audio".to_string(),
        };
        tick(); // Preserve captured samples and the meeting's microphone owner.
        *state.lock().unwrap() = RecordingState::Idle;
        tick(); // Recover automatically as soon as the recording ends.
        enabled.store(false, Ordering::Release);
        tick(); // Do not reopen on shutdown.

        assert_eq!(reopen_count, 1);
    }

    #[test]
    fn background_recovery_cannot_replace_a_stream_during_start_or_stop() {
        let lifecycle = Arc::new(Mutex::new(()));
        let worker_lifecycle = Arc::clone(&lifecycle);
        let operation = lifecycle.lock().unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            // Stop has already changed the state to Idle but still owns the
            // lifecycle gate while reading captured samples from the recorder.
            let result = recover_idle_always_on_microphone(
                &worker_lifecycle,
                &AtomicBool::new(true),
                &Mutex::new(MicrophoneMode::AlwaysOn),
                &Mutex::new(RecordingState::Idle),
                || panic!("must not inspect a stream during a lifecycle operation"),
                || panic!("must not discard the recorder during start/stop"),
            );
            tx.send(result).unwrap();
        });

        rx.recv_timeout(Duration::from_secs(1))
            .expect("monitor must skip a busy lifecycle without queuing")
            .unwrap();
        drop(operation);
        worker.join().unwrap();
    }

    #[test]
    fn mode_updates_complete_without_holding_the_mode_lock() {
        for (current, next) in [
            (MicrophoneMode::AlwaysOn, MicrophoneMode::AlwaysOn),
            (MicrophoneMode::OnDemand, MicrophoneMode::OnDemand),
            (MicrophoneMode::AlwaysOn, MicrophoneMode::OnDemand),
            (MicrophoneMode::OnDemand, MicrophoneMode::AlwaysOn),
        ] {
            let mode = Arc::new(Mutex::new(current));
            let worker_mode = mode.clone();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let result = update_microphone_mode(&worker_mode, next, |_, _| {
                    assert!(worker_mode.try_lock().is_ok());
                    Ok(())
                });
                tx.send(result).unwrap();
            });
            rx.recv_timeout(Duration::from_secs(1))
                .expect("mode update deadlocked")
                .unwrap();
        }
    }

    #[test]
    fn failed_microphone_start_keeps_the_previous_mode() {
        let mode = Mutex::new(MicrophoneMode::OnDemand);
        assert!(
            update_microphone_mode(&mode, MicrophoneMode::AlwaysOn, |_, _| {
                Err(anyhow::anyhow!("device unavailable"))
            })
            .is_err()
        );
        assert!(matches!(*mode.lock().unwrap(), MicrophoneMode::OnDemand));
    }

    #[test]
    fn short_recording_samples_are_padded_for_transcription() {
        let padded = pad_short_recording_samples(vec![0.25, -0.25]);

        assert_eq!(padded.len(), WHISPER_SAMPLE_RATE * 5 / 4);
        assert_eq!(&padded[..2], &[0.25, -0.25]);
    }
}
