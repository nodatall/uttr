use std::{
    collections::VecDeque,
    io::Error,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SizedSample,
};

use crate::audio_toolkit::{
    audio::{AudioVisualiser, FrameResampler},
    constants,
    vad::{self, VadFrame},
    VoiceActivityDetector,
};

enum Cmd {
    Start,
    Drain(mpsc::Sender<DrainResult>),
    Stop(mpsc::Sender<Vec<f32>>),
    Shutdown,
}

enum WorkerReady {
    Ready,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct DrainResult {
    pub samples: Vec<f32>,
    pub total_speech_samples: usize,
    pub saw_pause: bool,
}

pub struct AudioRecorder {
    device: Option<Device>,
    cmd_tx: Option<mpsc::Sender<Cmd>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
}

impl AudioRecorder {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(AudioRecorder {
            device: None,
            cmd_tx: None,
            worker_handle: None,
            vad: None,
            level_cb: None,
        })
    }

    pub fn with_vad(mut self, vad: Box<dyn VoiceActivityDetector>) -> Self {
        self.vad = Some(Arc::new(Mutex::new(vad)));
        self
    }

    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    pub fn open(&mut self, device: Option<Device>) -> Result<(), Box<dyn std::error::Error>> {
        if self.worker_handle.is_some() {
            return Ok(()); // already open
        }

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<WorkerReady>();

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| Error::new(std::io::ErrorKind::NotFound, "No input device found"))?,
        };

        let thread_device = device.clone();
        let vad = self.vad.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();

        let worker = std::thread::spawn(move || {
            let mut ready_tx = Some(ready_tx);
            let result = catch_unwind(AssertUnwindSafe(|| {
                let startup_result = (|| -> Result<(cpal::Stream, u32), String> {
                    let config = AudioRecorder::get_preferred_config(&thread_device)
                        .map_err(|err| format!("failed to fetch preferred config: {err}"))?;

                    let sample_rate = config.sample_rate().0;
                    let channels = config.channels() as usize;

                    log::info!(
                        "Using device: {:?}\nSample rate: {}\nChannels: {}\nFormat: {:?}",
                        thread_device.name(),
                        sample_rate,
                        channels,
                        config.sample_format()
                    );

                    let stream = match config.sample_format() {
                        cpal::SampleFormat::U8 => AudioRecorder::build_stream::<u8>(
                            &thread_device,
                            &config,
                            sample_tx,
                            channels,
                        ),
                        cpal::SampleFormat::I8 => AudioRecorder::build_stream::<i8>(
                            &thread_device,
                            &config,
                            sample_tx,
                            channels,
                        ),
                        cpal::SampleFormat::I16 => AudioRecorder::build_stream::<i16>(
                            &thread_device,
                            &config,
                            sample_tx,
                            channels,
                        ),
                        cpal::SampleFormat::I32 => AudioRecorder::build_stream::<i32>(
                            &thread_device,
                            &config,
                            sample_tx,
                            channels,
                        ),
                        cpal::SampleFormat::F32 => AudioRecorder::build_stream::<f32>(
                            &thread_device,
                            &config,
                            sample_tx,
                            channels,
                        ),
                        _ => return Err("unsupported sample format".to_string()),
                    }
                    .map_err(|err| format!("failed to build input stream: {err}"))?;

                    stream
                        .play()
                        .map_err(|err| format!("failed to start stream: {err}"))?;

                    Ok((stream, sample_rate))
                })();

                match startup_result {
                    Ok((stream, sample_rate)) => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(WorkerReady::Ready);
                        }
                        // keep the stream alive while we process samples
                        run_consumer(sample_rate, vad, sample_rx, cmd_rx, level_cb);
                        // stream is dropped here, after run_consumer returns
                        drop(stream);
                    }
                    Err(err) => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(WorkerReady::Failed(err));
                        }
                    }
                }
            }));

            if let Err(panic_payload) = result {
                let panic_msg = if let Some(msg) = panic_payload.downcast_ref::<&str>() {
                    msg.to_string()
                } else if let Some(msg) = panic_payload.downcast_ref::<String>() {
                    msg.clone()
                } else {
                    "unknown panic".to_string()
                };
                log::error!("Recorder worker panicked: {panic_msg}");
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(WorkerReady::Failed(format!(
                        "Recorder worker panicked: {panic_msg}"
                    )));
                }
            }
        });

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(WorkerReady::Ready) => {}
            Ok(WorkerReady::Failed(err)) => {
                let _ = worker.join();
                return Err(Box::new(Error::new(std::io::ErrorKind::Other, err)));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(Box::new(Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Timed out waiting for recorder worker to become ready",
                )));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = worker.join();
                return Err(Box::new(Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "Recorder worker exited before reporting readiness",
                )));
            }
        }

        self.device = Some(device);
        self.cmd_tx = Some(cmd_tx);
        self.worker_handle = Some(worker);

        Ok(())
    }

    pub fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Start)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        let tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| Error::new(std::io::ErrorKind::BrokenPipe, "Recorder is not open"))?;
        tx.send(Cmd::Stop(resp_tx))?;
        resp_rx
            .recv_timeout(Duration::from_millis(750))
            .map_err(|e| {
                let io_err = match e {
                    mpsc::RecvTimeoutError::Timeout => Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Timed out waiting for stop response",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "Recorder worker disconnected before stop response",
                    ),
                };
                Box::new(io_err) as Box<dyn std::error::Error>
            })
    }

    pub fn drain(&self) -> Result<DrainResult, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        let tx = self.cmd_tx.as_ref().ok_or_else(|| {
            Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Recorder command channel unavailable",
            )
        })?;
        tx.send(Cmd::Drain(resp_tx))?;
        resp_rx
            .recv_timeout(Duration::from_millis(75))
            .map_err(|e| {
                let io_err = match e {
                    mpsc::RecvTimeoutError::Timeout => Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Timed out waiting for drain response",
                    ),
                    mpsc::RecvTimeoutError::Disconnected => Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "Recorder worker disconnected before drain response",
                    ),
                };
                Box::new(io_err) as Box<dyn std::error::Error>
            })
    }

    pub fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        self.device = None;
        Ok(())
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sample_tx: mpsc::Sender<Vec<f32>>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            output_buffer.clear();

            if channels == 1 {
                // Direct conversion without intermediate Vec
                output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
            } else {
                // Convert to mono directly
                let frame_count = data.len() / channels;
                output_buffer.reserve(frame_count);

                for frame in data.chunks_exact(channels) {
                    let mono_sample = frame
                        .iter()
                        .map(|&sample| sample.to_sample::<f32>())
                        .sum::<f32>()
                        / channels as f32;
                    output_buffer.push(mono_sample);
                }
            }

            if sample_tx.send(output_buffer.clone()).is_err() {
                log::error!("Failed to send samples");
            }
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Stream error: {}", err),
            None,
        )
    }

    fn get_preferred_config(
        device: &cpal::Device,
    ) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
        let supported_configs = device.supported_input_configs()?;
        let mut best_config: Option<cpal::SupportedStreamConfigRange> = None;

        // Try to find a config that supports 16kHz, prioritizing better formats
        for config_range in supported_configs {
            if config_range.min_sample_rate().0 <= constants::WHISPER_SAMPLE_RATE
                && config_range.max_sample_rate().0 >= constants::WHISPER_SAMPLE_RATE
            {
                match best_config {
                    None => best_config = Some(config_range),
                    Some(ref current) => {
                        // Prioritize F32 > I16 > I32 > others
                        let score = |fmt: cpal::SampleFormat| match fmt {
                            cpal::SampleFormat::F32 => 4,
                            cpal::SampleFormat::I16 => 3,
                            cpal::SampleFormat::I32 => 2,
                            _ => 1,
                        };

                        if score(config_range.sample_format()) > score(current.sample_format()) {
                            best_config = Some(config_range);
                        }
                    }
                }
            }
        }

        if let Some(config) = best_config {
            return Ok(config.with_sample_rate(cpal::SampleRate(constants::WHISPER_SAMPLE_RATE)));
        }

        // If no config supports 16kHz, fall back to default
        Ok(device.default_input_config()?)
    }
}

struct PreRollBuffer {
    samples: VecDeque<f32>,
    max_samples: usize,
}

impl PreRollBuffer {
    fn new(max_samples: usize) -> Self {
        Self {
            samples: VecDeque::with_capacity(max_samples),
            max_samples,
        }
    }

    fn push_frame(&mut self, frame: &[f32]) {
        if self.max_samples == 0 || frame.is_empty() {
            return;
        }

        if frame.len() >= self.max_samples {
            self.samples.clear();
            self.samples
                .extend(frame[frame.len() - self.max_samples..].iter().copied());
            return;
        }

        let overflow = self
            .samples
            .len()
            .saturating_add(frame.len())
            .saturating_sub(self.max_samples);
        for _ in 0..overflow {
            self.samples.pop_front();
        }

        self.samples.extend(frame.iter().copied());
    }

    fn extend_into(&self, out: &mut Vec<f32>) {
        out.extend(self.samples.iter().copied());
    }
}

fn handle_start(
    processed_samples: &mut Vec<f32>,
    pre_roll_samples: &PreRollBuffer,
    recording: &mut bool,
    drain_cursor: &mut usize,
    silence_run_samples: &mut usize,
    saw_pause_since_last_drain: &mut bool,
    startup_passthrough_remaining: &mut usize,
    startup_passthrough_samples: usize,
) {
    processed_samples.clear();
    pre_roll_samples.extend_into(processed_samples);
    *recording = true;
    *drain_cursor = 0;
    *silence_run_samples = 0;
    *saw_pause_since_last_drain = false;
    *startup_passthrough_remaining = startup_passthrough_samples;
}

fn drain_recording(
    recording: bool,
    processed_samples: &[f32],
    drain_cursor: &mut usize,
    saw_pause_since_last_drain: &mut bool,
) -> DrainResult {
    if !recording {
        return DrainResult {
            samples: Vec::new(),
            total_speech_samples: 0,
            saw_pause: false,
        };
    }

    if *drain_cursor > processed_samples.len() {
        *drain_cursor = processed_samples.len();
    }

    let delta = processed_samples[*drain_cursor..].to_vec();
    *drain_cursor = processed_samples.len();
    let saw_pause = *saw_pause_since_last_drain;
    *saw_pause_since_last_drain = false;

    DrainResult {
        samples: delta,
        total_speech_samples: processed_samples.len(),
        saw_pause,
    }
}

fn run_consumer(
    in_sample_rate: u32,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    sample_rx: mpsc::Receiver<Vec<f32>>,
    cmd_rx: mpsc::Receiver<Cmd>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
) {
    const SPEECH_SAMPLE_RATE: usize = crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE as usize;
    // Recorder-local pre-roll only helps while upstream microphone streaming is already warm.
    // Long-idle stream-closed misses stay explicitly deferred to the audio manager lifecycle.
    const PRE_ROLL_SAMPLES: usize = SPEECH_SAMPLE_RATE * 500 / 1000; // 500ms
    const PAUSE_THRESHOLD_SAMPLES: usize = SPEECH_SAMPLE_RATE * 300 / 1000; // 300ms
    const STARTUP_PASSTHROUGH_SAMPLES: usize = SPEECH_SAMPLE_RATE * 350 / 1000; // 350ms

    let mut frame_resampler = FrameResampler::new(
        in_sample_rate as usize,
        SPEECH_SAMPLE_RATE,
        Duration::from_millis(30),
    );

    let mut processed_samples = Vec::<f32>::new();
    let mut pre_roll_samples = PreRollBuffer::new(PRE_ROLL_SAMPLES);
    let mut recording = false;
    let mut drain_cursor = 0usize;
    let mut silence_run_samples = 0usize;
    let mut saw_pause_since_last_drain = false;
    let mut startup_passthrough_remaining = 0usize;

    // ---------- spectrum visualisation setup ---------------------------- //
    const BUCKETS: usize = 16;
    const WINDOW_SIZE: usize = 512;
    let mut visualizer = AudioVisualiser::new(
        in_sample_rate,
        WINDOW_SIZE,
        BUCKETS,
        400.0,  // vocal_min_hz
        4000.0, // vocal_max_hz
    );

    fn handle_frame(
        samples: &[f32],
        recording: bool,
        vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
        out_buf: &mut Vec<f32>,
        startup_passthrough_remaining: &mut usize,
    ) -> bool {
        if !recording {
            return false;
        }

        // For the first slice after start, bypass VAD gating to avoid clipping
        // initial words while the detector stabilizes.
        if *startup_passthrough_remaining > 0 {
            out_buf.extend_from_slice(samples);
            *startup_passthrough_remaining =
                startup_passthrough_remaining.saturating_sub(samples.len());
            return true;
        }

        if let Some(vad_arc) = vad {
            let mut det = vad_arc.lock().unwrap();
            match det.push_frame(samples).unwrap_or(VadFrame::Speech(samples)) {
                VadFrame::Speech(buf) => {
                    out_buf.extend_from_slice(buf);
                    true
                }
                VadFrame::Noise => false,
            }
        } else {
            out_buf.extend_from_slice(samples);
            true
        }
    }

    fn handle_cmd(
        cmd: Cmd,
        recording: &mut bool,
        frame_resampler: &mut FrameResampler,
        processed_samples: &mut Vec<f32>,
        pre_roll_samples: &mut PreRollBuffer,
        vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
        visualizer: &mut AudioVisualiser,
        drain_cursor: &mut usize,
        silence_run_samples: &mut usize,
        saw_pause_since_last_drain: &mut bool,
        startup_passthrough_remaining: &mut usize,
    ) -> bool {
        match cmd {
            Cmd::Start => {
                handle_start(
                    processed_samples,
                    pre_roll_samples,
                    recording,
                    drain_cursor,
                    silence_run_samples,
                    saw_pause_since_last_drain,
                    startup_passthrough_remaining,
                    STARTUP_PASSTHROUGH_SAMPLES,
                );
                visualizer.reset(); // Reset visualization buffer
                if let Some(v) = vad {
                    v.lock().unwrap().reset();
                }
                false
            }
            Cmd::Drain(reply_tx) => {
                let _ = reply_tx.send(drain_recording(
                    *recording,
                    processed_samples,
                    drain_cursor,
                    saw_pause_since_last_drain,
                ));
                false
            }
            Cmd::Stop(reply_tx) => {
                *recording = false;

                let mut flush_passthrough = 0usize;
                frame_resampler.finish(&mut |frame: &[f32]| {
                    pre_roll_samples.push_frame(frame);
                    // we still want to process the last few frames
                    let _ =
                        handle_frame(frame, true, vad, processed_samples, &mut flush_passthrough);
                });

                *drain_cursor = 0;
                *silence_run_samples = 0;
                *saw_pause_since_last_drain = false;
                *startup_passthrough_remaining = 0;
                let _ = reply_tx.send(std::mem::take(processed_samples));
                false
            }
            Cmd::Shutdown => true,
        }
    }

    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            if handle_cmd(
                cmd,
                &mut recording,
                &mut frame_resampler,
                &mut processed_samples,
                &mut pre_roll_samples,
                &vad,
                &mut visualizer,
                &mut drain_cursor,
                &mut silence_run_samples,
                &mut saw_pause_since_last_drain,
                &mut startup_passthrough_remaining,
            ) {
                return;
            }
        }

        let raw = match sample_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(s) => s,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // stream closed
        };

        // ---------- spectrum processing ---------------------------------- //
        if let Some(buckets) = visualizer.feed(&raw) {
            if let Some(cb) = &level_cb {
                cb(buckets);
            }
        }

        // ---------- existing pipeline ------------------------------------ //
        frame_resampler.push(&raw, &mut |frame: &[f32]| {
            pre_roll_samples.push_frame(frame);
            let saw_speech = handle_frame(
                frame,
                recording,
                &vad,
                &mut processed_samples,
                &mut startup_passthrough_remaining,
            );
            if recording {
                if saw_speech {
                    silence_run_samples = 0;
                } else {
                    silence_run_samples = silence_run_samples.saturating_add(frame.len());
                    if silence_run_samples >= PAUSE_THRESHOLD_SAMPLES {
                        saw_pause_since_last_drain = true;
                    }
                }
            }
        });

        // non-blocking check for a command
        while let Ok(cmd) = cmd_rx.try_recv() {
            if handle_cmd(
                cmd,
                &mut recording,
                &mut frame_resampler,
                &mut processed_samples,
                &mut pre_roll_samples,
                &vad,
                &mut visualizer,
                &mut drain_cursor,
                &mut silence_run_samples,
                &mut saw_pause_since_last_drain,
                &mut startup_passthrough_remaining,
            ) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{drain_recording, handle_start, DrainResult, PreRollBuffer};

    #[test]
    fn recorder_pre_roll_buffer_caps_to_latest_samples() {
        let mut pre_roll = PreRollBuffer::new(5);
        pre_roll.push_frame(&[1.0, 2.0, 3.0]);
        pre_roll.push_frame(&[4.0, 5.0, 6.0, 7.0]);

        let mut seeded = Vec::new();
        pre_roll.extend_into(&mut seeded);

        assert_eq!(seeded, vec![3.0, 4.0, 5.0, 6.0, 7.0]);
    }

    #[test]
    fn recorder_start_resets_recording_state_and_seeds_current_pre_roll() {
        let mut pre_roll = PreRollBuffer::new(4);
        pre_roll.push_frame(&[7.0, 8.0]);

        let mut processed_samples = vec![1.0, 2.0, 3.0];
        let mut recording = false;
        let mut drain_cursor = 9;
        let mut silence_run_samples = 42;
        let mut saw_pause_since_last_drain = true;
        let mut startup_passthrough_remaining = 0;

        handle_start(
            &mut processed_samples,
            &pre_roll,
            &mut recording,
            &mut drain_cursor,
            &mut silence_run_samples,
            &mut saw_pause_since_last_drain,
            &mut startup_passthrough_remaining,
            123,
        );

        assert_eq!(processed_samples, vec![7.0, 8.0]);
        assert!(recording);
        assert_eq!(drain_cursor, 0);
        assert_eq!(silence_run_samples, 0);
        assert!(!saw_pause_since_last_drain);
        assert_eq!(startup_passthrough_remaining, 123);
    }

    #[test]
    fn recorder_drain_only_emits_new_samples_after_seeded_pre_roll() {
        let mut pre_roll = PreRollBuffer::new(4);
        pre_roll.push_frame(&[0.1, 0.2]);

        let mut processed_samples = vec![9.0];
        let mut recording = false;
        let mut drain_cursor = 0;
        let mut silence_run_samples = 12;
        let mut saw_pause_since_last_drain = true;
        let mut startup_passthrough_remaining = 0;

        handle_start(
            &mut processed_samples,
            &pre_roll,
            &mut recording,
            &mut drain_cursor,
            &mut silence_run_samples,
            &mut saw_pause_since_last_drain,
            &mut startup_passthrough_remaining,
            10,
        );

        processed_samples.extend_from_slice(&[0.3, 0.4]);
        let first = drain_recording(
            recording,
            &processed_samples,
            &mut drain_cursor,
            &mut saw_pause_since_last_drain,
        );
        let second = drain_recording(
            recording,
            &processed_samples,
            &mut drain_cursor,
            &mut saw_pause_since_last_drain,
        );

        assert_eq!(
            first,
            DrainResult {
                samples: vec![0.1, 0.2, 0.3, 0.4],
                total_speech_samples: 4,
                saw_pause: false,
            }
        );
        assert_eq!(
            second,
            DrainResult {
                samples: Vec::new(),
                total_speech_samples: 4,
                saw_pause: false,
            }
        );
    }

    #[test]
    fn recorder_drain_reports_pause_once_without_replaying_audio() {
        let processed_samples = vec![0.5, 0.6, 0.7];
        let mut drain_cursor = 1;
        let mut saw_pause_since_last_drain = true;

        let first = drain_recording(
            true,
            &processed_samples,
            &mut drain_cursor,
            &mut saw_pause_since_last_drain,
        );
        let second = drain_recording(
            true,
            &processed_samples,
            &mut drain_cursor,
            &mut saw_pause_since_last_drain,
        );

        assert_eq!(
            first,
            DrainResult {
                samples: vec![0.6, 0.7],
                total_speech_samples: 3,
                saw_pause: true,
            }
        );
        assert_eq!(
            second,
            DrainResult {
                samples: Vec::new(),
                total_speech_samples: 3,
                saw_pause: false,
            }
        );
    }
}
