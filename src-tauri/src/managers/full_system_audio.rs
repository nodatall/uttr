use crate::audio_toolkit::{
    constants::WHISPER_SAMPLE_RATE, mix_transcription_pcm_sources, normalize_transcription_pcm,
    DrainResult,
};
use crate::full_system_audio_bridge::{
    self, FullSystemAudioCaptureConfig, FullSystemAudioCapturedPcm, FullSystemAudioPermissionState,
    FullSystemAudioStartResult, FullSystemAudioStopResult,
};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::sanitize_transcription_audio;
use anyhow::anyhow;
use log::{debug, warn};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullSystemSessionSourceState {
    Inactive,
    Active,
}

impl Default for FullSystemSessionSourceState {
    fn default() -> Self {
        Self::Inactive
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FullSystemSourceOutcome {
    pub state: FullSystemSessionSourceState,
    pub error: Option<String>,
}

impl FullSystemSourceOutcome {
    fn active() -> Self {
        Self {
            state: FullSystemSessionSourceState::Active,
            error: None,
        }
    }

    fn inactive(error: Option<String>) -> Self {
        Self {
            state: FullSystemSessionSourceState::Inactive,
            error,
        }
    }

    fn is_active(&self) -> bool {
        matches!(self.state, FullSystemSessionSourceState::Active)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullSystemSessionSnapshot {
    pub session_id: u64,
    pub binding_id: String,
    pub system_audio: FullSystemSourceOutcome,
    pub microphone: FullSystemSourceOutcome,
    pub degraded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullSystemSessionStartResult {
    pub session: Option<FullSystemSessionSnapshot>,
    pub started: bool,
    pub new_session_started: bool,
    pub bridge_result: Option<FullSystemAudioStartResult>,
    pub system_audio_error: Option<String>,
    pub microphone_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullSystemTranscriptionSource {
    Microphone,
    SystemAudio,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FullSystemTranscriptionSourceSamples {
    pub source: FullSystemTranscriptionSource,
    pub samples: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FullSystemSessionTranscriptionSamples {
    pub mixed: Option<Vec<f32>>,
    pub sources: Vec<FullSystemTranscriptionSourceSamples>,
}

#[derive(Debug, PartialEq)]
pub struct FullSystemSessionStopResult {
    pub session: Option<FullSystemSessionSnapshot>,
    pub stopped: bool,
    pub had_active_session: bool,
    pub bridge_result: Option<FullSystemAudioStopResult>,
    pub transcription_samples: Option<Vec<f32>>,
    pub transcription_source_samples: Vec<FullSystemTranscriptionSourceSamples>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FullSystemSessionState {
    Idle,
    Starting { session_id: u64 },
    Active(FullSystemSessionSnapshot),
    Stopping { session_id: u64 },
}

impl Default for FullSystemSessionState {
    fn default() -> Self {
        Self::Idle
    }
}

impl FullSystemSessionState {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active(_))
    }

    pub fn is_idle(&self) -> bool {
        matches!(self, Self::Idle)
    }

    pub fn snapshot(&self) -> Option<FullSystemSessionSnapshot> {
        match self {
            Self::Active(snapshot) => Some(snapshot.clone()),
            _ => None,
        }
    }
}

pub trait MicrophoneCapture: Send + Sync {
    fn start_microphone_capture(&self, binding_id: &str) -> Result<(), anyhow::Error>;
    fn drain_microphone_capture(&self, binding_id: &str) -> Option<DrainResult>;
    fn stop_microphone_capture(&self, binding_id: &str) -> Option<Vec<f32>>;
    fn cancel_microphone_capture(&self);
}

impl MicrophoneCapture for AudioRecordingManager {
    fn start_microphone_capture(&self, binding_id: &str) -> Result<(), anyhow::Error> {
        if self.try_start_recording(binding_id) {
            Ok(())
        } else {
            Err(anyhow!("Microphone capture could not start."))
        }
    }

    fn drain_microphone_capture(&self, binding_id: &str) -> Option<DrainResult> {
        self.drain_recording_delta(binding_id)
    }

    fn stop_microphone_capture(&self, binding_id: &str) -> Option<Vec<f32>> {
        self.stop_recording(binding_id)
    }

    fn cancel_microphone_capture(&self) {
        self.cancel_recording();
    }
}

pub trait FullSystemAudioBackend: Send + Sync {
    fn is_supported(&self) -> bool;
    fn start_capture(&self, config: &FullSystemAudioCaptureConfig) -> FullSystemAudioStartResult;
    fn drain_capture(&self) -> FullSystemAudioStopResult;
    fn stop_capture(&self) -> FullSystemAudioStopResult;
    fn cancel_capture(&self);
    fn cleanup_last_session(&self);
}

#[derive(Debug, Default)]
pub struct BridgeBackend;

impl FullSystemAudioBackend for BridgeBackend {
    fn is_supported(&self) -> bool {
        full_system_audio_bridge::is_supported()
    }

    fn start_capture(&self, config: &FullSystemAudioCaptureConfig) -> FullSystemAudioStartResult {
        full_system_audio_bridge::start_capture(config)
    }

    fn drain_capture(&self) -> FullSystemAudioStopResult {
        full_system_audio_bridge::drain_capture()
    }

    fn stop_capture(&self) -> FullSystemAudioStopResult {
        full_system_audio_bridge::stop_capture()
    }

    fn cancel_capture(&self) {
        full_system_audio_bridge::cancel_capture();
    }

    fn cleanup_last_session(&self) {
        full_system_audio_bridge::cleanup_last_session();
    }
}

#[derive(Clone)]
pub struct FullSystemAudioSessionManager<M = AudioRecordingManager, B = BridgeBackend>
where
    M: MicrophoneCapture,
    B: FullSystemAudioBackend,
{
    microphone: Arc<M>,
    bridge: Arc<B>,
    state: Arc<Mutex<FullSystemSessionState>>,
    next_session_id: Arc<AtomicU64>,
}

impl FullSystemAudioSessionManager<AudioRecordingManager, BridgeBackend> {
    pub fn new(microphone: Arc<AudioRecordingManager>) -> Self {
        Self::with_backend(microphone, Arc::new(BridgeBackend))
    }
}

impl<M, B> FullSystemAudioSessionManager<M, B>
where
    M: MicrophoneCapture,
    B: FullSystemAudioBackend,
{
    pub fn with_backend(microphone: Arc<M>, bridge: Arc<B>) -> Self {
        Self {
            microphone,
            bridge,
            state: Arc::new(Mutex::new(FullSystemSessionState::Idle)),
            next_session_id: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn state(&self) -> FullSystemSessionState {
        self.state.lock().unwrap().clone()
    }

    pub fn is_active(&self) -> bool {
        self.state.lock().unwrap().is_active()
    }

    pub fn is_idle(&self) -> bool {
        self.state.lock().unwrap().is_idle()
    }

    pub fn start_session(
        &self,
        binding_id: &str,
        config: FullSystemAudioCaptureConfig,
    ) -> FullSystemSessionStartResult {
        {
            let mut state = self.state.lock().unwrap();
            match &*state {
                FullSystemSessionState::Idle => {
                    let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed) + 1;
                    *state = FullSystemSessionState::Starting { session_id };
                }
                FullSystemSessionState::Active(snapshot) => {
                    return FullSystemSessionStartResult {
                        session: Some(snapshot.clone()),
                        started: true,
                        new_session_started: false,
                        bridge_result: None,
                        system_audio_error: None,
                        microphone_error: None,
                    };
                }
                FullSystemSessionState::Starting { .. }
                | FullSystemSessionState::Stopping { .. } => {
                    return FullSystemSessionStartResult {
                        session: state.snapshot(),
                        started: state.is_active(),
                        new_session_started: false,
                        bridge_result: None,
                        system_audio_error: Some(
                            "A full-system session is already in progress.".to_string(),
                        ),
                        microphone_error: Some(
                            "A full-system session is already in progress.".to_string(),
                        ),
                    };
                }
            }
        }

        let session_id = match self.state() {
            FullSystemSessionState::Starting { session_id } => session_id,
            _ => {
                return FullSystemSessionStartResult {
                    session: None,
                    started: false,
                    new_session_started: false,
                    bridge_result: None,
                    system_audio_error: Some(
                        "Failed to enter the full-system session starting state.".to_string(),
                    ),
                    microphone_error: Some(
                        "Failed to enter the full-system session starting state.".to_string(),
                    ),
                }
            }
        };

        let bridge_result = if self.bridge.is_supported() {
            Some(self.bridge.start_capture(&config))
        } else {
            None
        };

        let system_audio = match bridge_result.as_ref() {
            Some(result) if result.started == 1 => FullSystemSourceOutcome::active(),
            Some(result) => FullSystemSourceOutcome::inactive(Some(
                system_audio_start_error(result.permission_state).to_string(),
            )),
            None => FullSystemSourceOutcome::inactive(Some(
                "Full-system audio capture is unavailable on this platform.".to_string(),
            )),
        };

        let (microphone, microphone_error) =
            match self.microphone.start_microphone_capture(binding_id) {
                Ok(()) => (FullSystemSourceOutcome::active(), None),
                Err(err) => {
                    let message = err.to_string();
                    warn!("Microphone capture failed to start for full-system session: {message}");
                    (
                        FullSystemSourceOutcome::inactive(Some(message.clone())),
                        Some(message),
                    )
                }
            };

        let session = if system_audio.is_active() || microphone.is_active() {
            let snapshot = FullSystemSessionSnapshot {
                session_id,
                binding_id: binding_id.to_string(),
                system_audio: system_audio.clone(),
                microphone: microphone.clone(),
                degraded: !(system_audio.is_active() && microphone.is_active()),
            };

            let mut state = self.state.lock().unwrap();
            *state = FullSystemSessionState::Active(snapshot.clone());
            Some(snapshot)
        } else {
            debug!("Full-system session start failed before any source became active");
            self.cleanup_last_session();
            let mut state = self.state.lock().unwrap();
            *state = FullSystemSessionState::Idle;
            None
        };

        let started = session.is_some();
        if !started {
            return FullSystemSessionStartResult {
                session,
                started,
                new_session_started: true,
                bridge_result,
                system_audio_error: system_audio.error.clone(),
                microphone_error,
            };
        }

        FullSystemSessionStartResult {
            session,
            started,
            new_session_started: true,
            bridge_result,
            system_audio_error: system_audio.error.clone(),
            microphone_error,
        }
    }

    pub fn stop_session(&self) -> FullSystemSessionStopResult {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            match state.clone() {
                FullSystemSessionState::Active(snapshot) => {
                    *state = FullSystemSessionState::Stopping {
                        session_id: snapshot.session_id,
                    };
                    Some(snapshot)
                }
                FullSystemSessionState::Starting { session_id }
                | FullSystemSessionState::Stopping { session_id } => {
                    warn!(
                        "Full-system session {session_id} was busy during stop; treating as idle"
                    );
                    None
                }
                FullSystemSessionState::Idle => None,
            }
        };

        let Some(snapshot) = snapshot else {
            return FullSystemSessionStopResult {
                session: None,
                stopped: false,
                had_active_session: false,
                bridge_result: None,
                transcription_samples: None,
                transcription_source_samples: Vec::new(),
            };
        };

        let mut bridge_result = if snapshot.system_audio.is_active() {
            Some(self.bridge.stop_capture())
        } else {
            None
        };

        let microphone_samples = if snapshot.microphone.is_active() {
            self.microphone
                .stop_microphone_capture(&snapshot.binding_id)
        } else {
            None
        };
        let transcription_payload = build_session_transcription_samples(
            microphone_samples,
            bridge_result
                .as_mut()
                .and_then(|result| result.pcm.take_samples()),
        );
        let transcription_samples = transcription_payload.mixed.clone();
        self.cleanup_last_session();

        let mut state = self.state.lock().unwrap();
        *state = FullSystemSessionState::Idle;

        FullSystemSessionStopResult {
            session: Some(snapshot),
            stopped: true,
            had_active_session: true,
            bridge_result,
            transcription_samples,
            transcription_source_samples: transcription_payload.sources,
        }
    }

    pub fn drain_session_delta(&self, binding_id: &str) -> Option<Vec<f32>> {
        self.drain_session_delta_sources(binding_id)
            .and_then(|payload| payload.mixed)
    }

    pub fn drain_session_delta_sources(
        &self,
        binding_id: &str,
    ) -> Option<FullSystemSessionTranscriptionSamples> {
        let snapshot = {
            let state = self.state.lock().unwrap();
            match state.clone() {
                FullSystemSessionState::Active(snapshot) if snapshot.binding_id == binding_id => {
                    snapshot
                }
                _ => return None,
            }
        };

        let microphone_samples = if snapshot.microphone.is_active() {
            self.microphone
                .drain_microphone_capture(&snapshot.binding_id)
                .map(|delta| delta.samples)
        } else {
            None
        };

        let mut bridge_result = if snapshot.system_audio.is_active() {
            Some(self.bridge.drain_capture())
        } else {
            None
        };

        let payload = build_session_transcription_samples(
            microphone_samples,
            bridge_result
                .as_mut()
                .and_then(|result| result.pcm.take_samples()),
        );

        (payload.mixed.is_some() || !payload.sources.is_empty()).then_some(payload)
    }

    pub fn cancel_session(&self) -> FullSystemSessionStopResult {
        let snapshot = {
            let mut state = self.state.lock().unwrap();
            match state.clone() {
                FullSystemSessionState::Active(snapshot) => {
                    *state = FullSystemSessionState::Stopping {
                        session_id: snapshot.session_id,
                    };
                    Some(snapshot)
                }
                FullSystemSessionState::Starting { session_id }
                | FullSystemSessionState::Stopping { session_id } => {
                    warn!(
                        "Full-system session {session_id} was busy during cancel; treating as idle"
                    );
                    None
                }
                FullSystemSessionState::Idle => None,
            }
        };

        let Some(snapshot) = snapshot else {
            return FullSystemSessionStopResult {
                session: None,
                stopped: false,
                had_active_session: false,
                bridge_result: None,
                transcription_samples: None,
                transcription_source_samples: Vec::new(),
            };
        };

        self.bridge.cancel_capture();
        self.microphone.cancel_microphone_capture();
        self.cleanup_last_session();

        let mut state = self.state.lock().unwrap();
        *state = FullSystemSessionState::Idle;

        FullSystemSessionStopResult {
            session: Some(snapshot),
            stopped: true,
            had_active_session: true,
            bridge_result: None,
            transcription_samples: None,
            transcription_source_samples: Vec::new(),
        }
    }

    pub fn cleanup_last_session(&self) {
        self.bridge.cleanup_last_session();
    }
}

fn build_session_transcription_samples(
    microphone_samples: Option<Vec<f32>>,
    system_audio: Option<FullSystemAudioCapturedPcm>,
) -> FullSystemSessionTranscriptionSamples {
    let mut sources = Vec::new();
    let mut normalized_sources = Vec::new();

    if let Some(samples) = microphone_samples {
        match normalize_transcription_pcm(&samples, WHISPER_SAMPLE_RATE, 1) {
            Ok(normalized) if !normalized.is_empty() => {
                let samples = sanitize_transcription_audio(normalized);
                normalized_sources.push(samples.clone());
                sources.push(FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples,
                });
            }
            Ok(_) => {}
            Err(err) => warn!("Failed to normalize microphone samples for transcription: {err}"),
        }
    }

    if let Some(system_audio) = system_audio {
        match normalize_transcription_pcm(
            &system_audio.samples,
            system_audio.sample_rate,
            system_audio.channel_count,
        ) {
            Ok(normalized) if !normalized.is_empty() => {
                let samples = sanitize_transcription_audio(normalized);
                normalized_sources.push(samples.clone());
                sources.push(FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples,
                });
            }
            Ok(_) => {}
            Err(err) => warn!("Failed to normalize system audio samples for transcription: {err}"),
        }
    }

    let mixed = match normalized_sources.as_slice() {
        [] => None,
        [samples] => Some(samples.clone()),
        _ => {
            let source_refs: Vec<&[f32]> = normalized_sources
                .iter()
                .map(|samples| samples.as_slice())
                .collect();
            Some(mix_transcription_pcm_sources(&source_refs))
        }
    };

    FullSystemSessionTranscriptionSamples {
        mixed: mixed.map(sanitize_transcription_audio),
        sources,
    }
}

fn system_audio_start_error(permission_state: i32) -> &'static str {
    match FullSystemAudioPermissionState::from(permission_state) {
        FullSystemAudioPermissionState::Granted => "Full-system audio capture did not start.",
        FullSystemAudioPermissionState::Denied => {
            "Screen Recording access is required before full-system audio recording can start."
        }
        FullSystemAudioPermissionState::NotDetermined => {
            "Screen Recording access is required before full-system audio recording can start."
        }
        FullSystemAudioPermissionState::Error => "Uttr could not check Screen Recording access.",
        FullSystemAudioPermissionState::Unsupported => {
            "Full-system audio recording is unavailable in this build of Uttr."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeMicrophone {
        start_result: Mutex<Option<Result<(), anyhow::Error>>>,
        drain_result: Mutex<Option<DrainResult>>,
        stop_result: Mutex<Option<Vec<f32>>>,
        start_calls: AtomicUsize,
        drain_calls: AtomicUsize,
        stop_calls: AtomicUsize,
        cancel_calls: AtomicUsize,
    }

    impl FakeMicrophone {
        fn with_start_result(result: Result<(), anyhow::Error>) -> Self {
            Self {
                start_result: Mutex::new(Some(result)),
                ..Self::default()
            }
        }

        fn start_calls(&self) -> usize {
            self.start_calls.load(Ordering::SeqCst)
        }

        fn stop_calls(&self) -> usize {
            self.stop_calls.load(Ordering::SeqCst)
        }

        fn drain_calls(&self) -> usize {
            self.drain_calls.load(Ordering::SeqCst)
        }

        fn cancel_calls(&self) -> usize {
            self.cancel_calls.load(Ordering::SeqCst)
        }
    }

    impl MicrophoneCapture for FakeMicrophone {
        fn start_microphone_capture(&self, _binding_id: &str) -> Result<(), anyhow::Error> {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            self.start_result
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Ok(()))
        }

        fn stop_microphone_capture(&self, _binding_id: &str) -> Option<Vec<f32>> {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
            self.stop_result.lock().unwrap().take()
        }

        fn drain_microphone_capture(&self, _binding_id: &str) -> Option<DrainResult> {
            self.drain_calls.fetch_add(1, Ordering::SeqCst);
            self.drain_result.lock().unwrap().take()
        }

        fn cancel_microphone_capture(&self) {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct FakeBridge {
        supported: bool,
        start_result: Mutex<Option<FullSystemAudioStartResult>>,
        drain_result: Mutex<Option<FullSystemAudioStopResult>>,
        stop_result: Mutex<Option<FullSystemAudioStopResult>>,
        start_calls: AtomicUsize,
        drain_calls: AtomicUsize,
        stop_calls: AtomicUsize,
        cancel_calls: AtomicUsize,
        cleanup_calls: AtomicUsize,
    }

    impl FakeBridge {
        fn supported(start_result: FullSystemAudioStartResult) -> Self {
            Self {
                supported: true,
                start_result: Mutex::new(Some(start_result)),
                stop_result: Mutex::new(Some(FullSystemAudioStopResult::default())),
                ..Self::default()
            }
        }

        fn with_stop_result(
            start_result: FullSystemAudioStartResult,
            stop_result: FullSystemAudioStopResult,
        ) -> Self {
            Self {
                supported: true,
                start_result: Mutex::new(Some(start_result)),
                stop_result: Mutex::new(Some(stop_result)),
                ..Self::default()
            }
        }

        fn start_calls(&self) -> usize {
            self.start_calls.load(Ordering::SeqCst)
        }

        fn stop_calls(&self) -> usize {
            self.stop_calls.load(Ordering::SeqCst)
        }

        fn drain_calls(&self) -> usize {
            self.drain_calls.load(Ordering::SeqCst)
        }

        fn cancel_calls(&self) -> usize {
            self.cancel_calls.load(Ordering::SeqCst)
        }

        fn cleanup_calls(&self) -> usize {
            self.cleanup_calls.load(Ordering::SeqCst)
        }
    }

    impl FullSystemAudioBackend for FakeBridge {
        fn is_supported(&self) -> bool {
            self.supported
        }

        fn start_capture(
            &self,
            _config: &FullSystemAudioCaptureConfig,
        ) -> FullSystemAudioStartResult {
            self.start_calls.fetch_add(1, Ordering::SeqCst);
            self.start_result.lock().unwrap().take().unwrap_or_default()
        }

        fn stop_capture(&self) -> FullSystemAudioStopResult {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
            self.stop_result.lock().unwrap().take().unwrap_or_default()
        }

        fn drain_capture(&self) -> FullSystemAudioStopResult {
            self.drain_calls.fetch_add(1, Ordering::SeqCst);
            self.drain_result.lock().unwrap().take().unwrap_or_default()
        }

        fn cancel_capture(&self) {
            self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        }

        fn cleanup_last_session(&self) {
            self.cleanup_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn supported_start_result() -> FullSystemAudioStartResult {
        FullSystemAudioStartResult {
            started: 1,
            permission_state: FullSystemAudioPermissionState::Granted.into(),
        }
    }

    fn failed_start_result() -> FullSystemAudioStartResult {
        FullSystemAudioStartResult {
            started: 0,
            permission_state: FullSystemAudioPermissionState::Denied.into(),
        }
    }

    fn stop_result_with_pcm(
        samples: &[f32],
        sample_rate: i32,
        channel_count: i32,
    ) -> FullSystemAudioStopResult {
        let sample_count = samples.len() as usize;
        let frame_count = if channel_count > 0 {
            (sample_count / channel_count as usize) as i64
        } else {
            0
        };

        FullSystemAudioStopResult {
            stopped: 1,
            sample_rate,
            channel_count,
            frame_count,
            pcm: full_system_audio_bridge::owned_pcm_buffer_from_samples(
                samples,
                sample_rate,
                channel_count,
            ),
        }
    }

    fn drain_result(samples: &[f32]) -> DrainResult {
        DrainResult {
            samples: samples.to_vec(),
            total_speech_samples: samples.len(),
            saw_pause: false,
        }
    }

    #[test]
    fn starts_both_sources_and_records_an_active_session() {
        let microphone = Arc::new(FakeMicrophone {
            stop_result: Mutex::new(Some(vec![0.25, -0.25])),
            ..FakeMicrophone::default()
        });
        let bridge = Arc::new(FakeBridge::with_stop_result(
            supported_start_result(),
            stop_result_with_pcm(&[0.5, 0.5], 16000, 1),
        ));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(result.started);
        assert!(result.new_session_started);
        assert!(result.session.is_some());
        assert!(manager.is_active());
        assert_eq!(microphone.start_calls(), 1);
        assert_eq!(bridge.start_calls(), 1);
        assert!(result
            .session
            .as_ref()
            .expect("missing session")
            .system_audio
            .is_active());
        assert!(result
            .session
            .as_ref()
            .expect("missing session")
            .microphone
            .is_active());
        assert_eq!(
            result.session.as_ref().expect("missing session").binding_id,
            "transcribe_full_system_audio"
        );

        let stop_result = manager.stop_session();

        assert!(stop_result.stopped);
        assert!(stop_result.had_active_session);
        assert!(stop_result.session.is_some());
        assert!(manager.is_idle());
        assert_eq!(microphone.stop_calls(), 1);
        assert_eq!(bridge.stop_calls(), 1);
        assert_eq!(bridge.cleanup_calls(), 1);
        assert_eq!(stop_result.transcription_samples, Some(vec![0.375, 0.125]));
        assert_eq!(
            stop_result.transcription_source_samples,
            vec![
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: vec![0.25, -0.25],
                },
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.5, 0.5],
                },
            ]
        );
    }

    #[test]
    fn drain_session_delta_sources_preserves_source_buffers_and_mixed_audio() {
        let microphone = Arc::new(FakeMicrophone {
            drain_result: Mutex::new(Some(drain_result(&[0.2, -0.2]))),
            ..FakeMicrophone::default()
        });
        let bridge = Arc::new(FakeBridge {
            supported: true,
            start_result: Mutex::new(Some(supported_start_result())),
            drain_result: Mutex::new(Some(stop_result_with_pcm(&[0.4, 0.4], 16000, 1))),
            ..FakeBridge::default()
        });
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let start_result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );
        assert!(start_result.started);

        let delta = manager
            .drain_session_delta_sources("transcribe_full_system_audio")
            .expect("source delta");

        assert_eq!(microphone.drain_calls(), 1);
        assert_eq!(bridge.drain_calls(), 1);
        assert_eq!(delta.mixed, Some(vec![0.3, 0.1]));
        assert_eq!(
            delta.sources,
            vec![
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::Microphone,
                    samples: vec![0.2, -0.2],
                },
                FullSystemTranscriptionSourceSamples {
                    source: FullSystemTranscriptionSource::SystemAudio,
                    samples: vec![0.4, 0.4],
                },
            ]
        );
    }

    #[test]
    fn keeps_session_alive_when_microphone_start_fails() {
        let microphone = Arc::new(FakeMicrophone::with_start_result(Err(anyhow!(
            "mic failed"
        ))));
        let bridge = Arc::new(FakeBridge::with_stop_result(
            supported_start_result(),
            stop_result_with_pcm(&[0.25, -0.25], 16000, 1),
        ));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(result.started);
        assert!(result.session.is_some());
        assert!(result.session.as_ref().expect("missing session").degraded);
        assert!(result.microphone_error.is_some());
        assert_eq!(microphone.start_calls(), 1);
        assert_eq!(bridge.start_calls(), 1);

        let stop_result = manager.stop_session();

        assert!(stop_result.stopped);
        assert_eq!(microphone.stop_calls(), 0);
        assert_eq!(bridge.stop_calls(), 1);
        assert_eq!(stop_result.transcription_samples, Some(vec![0.25, -0.25]));
    }

    #[test]
    fn cancel_session_resets_degraded_system_only_session() {
        let microphone = Arc::new(FakeMicrophone::with_start_result(Err(anyhow!(
            "mic failed"
        ))));
        let bridge = Arc::new(FakeBridge::supported(supported_start_result()));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(result.started);
        assert!(result.session.as_ref().expect("missing session").degraded);
        assert!(manager.is_active());

        let cancel_result = manager.cancel_session();

        assert!(cancel_result.stopped);
        assert!(cancel_result.had_active_session);
        assert!(manager.is_idle());
        assert_eq!(microphone.cancel_calls(), 1);
        assert_eq!(bridge.cancel_calls(), 1);
        assert_eq!(bridge.stop_calls(), 0);
        assert_eq!(bridge.cleanup_calls(), 1);
    }

    #[test]
    fn keeps_session_alive_when_system_start_fails() {
        let microphone = Arc::new(FakeMicrophone {
            stop_result: Mutex::new(Some(vec![0.25, -0.25])),
            ..FakeMicrophone::default()
        });
        let bridge = Arc::new(FakeBridge::supported(failed_start_result()));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(result.started);
        assert!(result.session.is_some());
        assert!(result.system_audio_error.is_some());
        assert!(result.session.as_ref().expect("missing session").degraded);
        assert_eq!(microphone.start_calls(), 1);
        assert_eq!(bridge.start_calls(), 1);

        let stop_result = manager.stop_session();

        assert!(stop_result.stopped);
        assert_eq!(microphone.stop_calls(), 1);
        assert_eq!(bridge.stop_calls(), 0);
        assert_eq!(bridge.cleanup_calls(), 1);
        assert_eq!(stop_result.transcription_samples, Some(vec![0.25, -0.25]));
    }

    #[test]
    fn cancel_session_resets_state_and_invokes_bridge_cancel() {
        let microphone = Arc::new(FakeMicrophone::default());
        let bridge = Arc::new(FakeBridge::supported(supported_start_result()));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let start_result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );
        assert!(start_result.started);

        let cancel_result = manager.cancel_session();

        assert!(cancel_result.stopped);
        assert!(manager.is_idle());
        assert_eq!(microphone.cancel_calls(), 1);
        assert_eq!(bridge.cancel_calls(), 1);
        assert_eq!(bridge.stop_calls(), 0);
        assert_eq!(bridge.cleanup_calls(), 1);
    }

    #[test]
    fn start_is_noop_when_session_is_already_active() {
        let microphone = Arc::new(FakeMicrophone::default());
        let bridge = Arc::new(FakeBridge::supported(supported_start_result()));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let first = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );
        let second = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(first.started);
        assert!(second.started);
        assert!(!second.new_session_started);
        assert_eq!(microphone.start_calls(), 1);
        assert_eq!(bridge.start_calls(), 1);
    }

    #[test]
    fn start_fails_cleanly_when_no_source_becomes_active() {
        let microphone = Arc::new(FakeMicrophone::with_start_result(Err(anyhow!(
            "mic failed"
        ))));
        let bridge = Arc::new(FakeBridge::supported(failed_start_result()));
        let manager =
            FullSystemAudioSessionManager::with_backend(microphone.clone(), bridge.clone());

        let result = manager.start_session(
            "transcribe_full_system_audio",
            FullSystemAudioCaptureConfig::default(),
        );

        assert!(!result.started);
        assert!(result.session.is_none());
        assert!(manager.is_idle());
        assert_eq!(microphone.start_calls(), 1);
        assert_eq!(bridge.start_calls(), 1);
        assert_eq!(bridge.cleanup_calls(), 1);
    }
}
