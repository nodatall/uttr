use std::{
    ops::Range,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::Instant,
};

const CAPTURE_FRAME_SAMPLES: usize = 480;
// Silero v4's shortest trained window at 16 kHz.
const MODEL_FRAME_SAMPLES: usize = 512;
const QUEUED_FRAMES: usize = 256;
// Bound bookkeeping as well as queued PCM. Longer sessions continue normally.
const MAX_SAMPLES: usize = 16_000 * 60 * 60 * 2;
const MAX_RETAINED_BLOCKS: usize = MAX_SAMPLES / CAPTURE_FRAME_SAMPLES + 32;
const MAX_SCORE_BLOCKS: usize = MAX_SAMPLES / MODEL_FRAME_SAMPLES + 32;

#[derive(Clone, Copy, Debug)]
pub enum SpeechEvidence {
    Unknown,
    Complete { max_score: f32 },
}

struct RetainedBlock {
    retained: Range<usize>,
    source: Range<usize>,
}

struct Score {
    source: Range<usize>,
    value: f32,
}

#[derive(Default)]
struct EvidenceState {
    retained: Vec<RetainedBlock>,
    retained_samples: usize,
    scores: Vec<Score>,
    covered_samples: usize,
    raw_samples: usize,
    complete: bool,
}

struct Session {
    binding_id: String,
    operation_id: u64,
    invalid: AtomicBool,
    invalid_reason: AtomicU8,
    state: Mutex<EvidenceState>,
}

/// A recording's identity and ready evidence. Inspection never waits for inference.
#[derive(Clone)]
pub struct DictationAnalysis {
    session: Arc<Session>,
    tx: SyncSender<Message>,
}

impl DictationAnalysis {
    pub(crate) fn binding_matches(&self, binding_id: &str) -> bool {
        self.session.binding_id == binding_id
    }

    pub fn matches(&self, binding_id: &str, operation_id: u64) -> bool {
        self.session.binding_id == binding_id && self.session.operation_id == operation_id
    }

    pub fn invalidate(&self) {
        self.invalidate_as(2);
    }

    fn invalidate_as(&self, reason: u8) {
        let _ = self.session.invalid_reason.compare_exchange(
            0,
            reason,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.session.invalid.store(true, Ordering::Release);
    }

    pub fn evidence(&self, retained_range: Range<usize>) -> SpeechEvidence {
        if self.session.invalid.load(Ordering::Acquire) || retained_range.is_empty() {
            return SpeechEvidence::Unknown;
        }
        let Ok(state) = self.session.state.try_lock() else {
            return SpeechEvidence::Unknown;
        };
        if state.covered_samples < MODEL_FRAME_SAMPLES
            || retained_range.end > state.retained_samples
        {
            return SpeechEvidence::Unknown;
        }
        let mut cursor = retained_range.start;
        let mut max_score = 0.0f32;
        let first = state
            .retained
            .partition_point(|block| block.retained.end <= cursor);
        for block in &state.retained[first..] {
            if block.retained.start >= retained_range.end {
                break;
            }
            if block.retained.start > cursor || block.source.end > state.covered_samples {
                return SpeechEvidence::Unknown;
            }
            // A capture prefill may duplicate earlier PCM. Inspect the complete
            // original source block conservatively, never its retained offset.
            let score_start = state
                .scores
                .partition_point(|score| score.source.end <= block.source.start);
            for score in &state.scores[score_start..] {
                if score.source.start >= block.source.end {
                    break;
                }
                max_score = max_score.max(score.value);
            }
            cursor = block.retained.end.min(retained_range.end);
        }
        if cursor == retained_range.end {
            SpeechEvidence::Complete { max_score }
        } else {
            SpeechEvidence::Unknown
        }
    }

    pub fn whole_recording_evidence(&self) -> SpeechEvidence {
        if self.session.invalid.load(Ordering::Acquire) {
            return SpeechEvidence::Unknown;
        }
        let Ok(state) = self.session.state.try_lock() else {
            return SpeechEvidence::Unknown;
        };
        if !state.complete || state.raw_samples == 0 {
            return SpeechEvidence::Unknown;
        }
        SpeechEvidence::Complete {
            max_score: state
                .scores
                .iter()
                .map(|score| score.value)
                .fold(0.0, f32::max),
        }
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.invalidate_as(1);
        }
    }

    pub(super) fn observe(&self, samples: &[f32], valid_samples: Option<usize>) {
        let Some(valid_samples) = valid_samples.filter(|&valid| valid <= samples.len()) else {
            self.invalidate_as(3);
            return;
        };
        if self.session.invalid.load(Ordering::Acquire) {
            return;
        }
        for chunk in samples[..valid_samples].chunks(CAPTURE_FRAME_SAMPLES) {
            if chunk.iter().any(|sample| !sample.is_finite()) {
                self.invalidate_as(4);
                return;
            }
            self.send(Message::Samples(self.session.clone(), chunk.to_vec()));
        }
    }

    pub(super) fn retain(&self, retained_len: usize, source: Range<usize>) {
        if retained_len == 0 || self.session.invalid.load(Ordering::Acquire) {
            return;
        }
        if source.end > MAX_SAMPLES || source.start > source.end || source.len() > retained_len {
            self.invalidate_as(3);
            return;
        }
        self.send(Message::Retained(
            self.session.clone(),
            retained_len,
            source,
        ));
    }

    pub(super) fn finish(&self) {
        self.send(Message::Finish(self.session.clone()));
    }
}

enum Message {
    Begin(Arc<Session>),
    Samples(Arc<Session>, Vec<f32>),
    Retained(Arc<Session>, usize, Range<usize>),
    Finish(Arc<Session>),
}

#[derive(Clone)]
pub struct SpeechObserver {
    tx: SyncSender<Message>,
}

impl SpeechObserver {
    pub fn new(model_path: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel(QUEUED_FRAMES);
        std::thread::spawn(move || run_worker(model_path, rx));
        Self { tx }
    }

    pub fn begin(&self, binding_id: &str, operation_id: u64) -> DictationAnalysis {
        let handle = DictationAnalysis {
            session: Arc::new(Session {
                binding_id: binding_id.to_string(),
                operation_id,
                invalid: AtomicBool::new(false),
                invalid_reason: AtomicU8::new(0),
                state: Mutex::new(EvidenceState::default()),
            }),
            tx: self.tx.clone(),
        };
        handle.send(Message::Begin(handle.session.clone()));
        handle
    }
}

struct WorkerSession {
    session: Arc<Session>,
    pending: Vec<f32>,
    raw_samples: usize,
    processed_samples: usize,
    chronological_max_score: Option<f32>,
    process_micros: u128,
}

fn run_worker(model_path: PathBuf, rx: mpsc::Receiver<Message>) {
    let mut model = None;
    let mut active: Option<WorkerSession> = None;
    let mut init_micros = 0;
    while let Ok(message) = rx.recv() {
        match message {
            Message::Begin(session) => {
                if let Some(previous) = active.take() {
                    previous.session.invalid.store(true, Ordering::Release);
                }
                if session.invalid.load(Ordering::Acquire) {
                    continue;
                }
                init_micros = 0;
                if model.is_none() {
                    let started = Instant::now();
                    match vad_rs::Vad::new(&model_path, 16_000) {
                        Ok(loaded) => model = Some(loaded),
                        Err(error) => {
                            log::warn!("Dictation speech observer could not load: {error}");
                            session.invalid.store(true, Ordering::Release);
                            session.invalid_reason.store(5, Ordering::Release);
                        }
                    }
                    init_micros = started.elapsed().as_micros();
                }
                if let Some(model) = model.as_mut() {
                    model.reset();
                }
                active = Some(WorkerSession {
                    session,
                    pending: Vec::with_capacity(MODEL_FRAME_SAMPLES),
                    raw_samples: 0,
                    processed_samples: 0,
                    chronological_max_score: None,
                    process_micros: 0,
                });
            }
            Message::Samples(session, samples) => {
                let Some(worker) = active.as_mut().filter(|worker| {
                    Arc::ptr_eq(&worker.session, &session)
                        && !session.invalid.load(Ordering::Acquire)
                }) else {
                    continue;
                };
                if worker.raw_samples.saturating_add(samples.len()) > MAX_SAMPLES {
                    session.invalid.store(true, Ordering::Release);
                    session.invalid_reason.store(1, Ordering::Release);
                    continue;
                }
                worker.raw_samples += samples.len();
                worker.pending.extend_from_slice(&samples);
                while worker.pending.len() >= MODEL_FRAME_SAMPLES {
                    let frame: Vec<_> = worker.pending.drain(..MODEL_FRAME_SAMPLES).collect();
                    let source =
                        worker.processed_samples..worker.processed_samples + MODEL_FRAME_SAMPLES;
                    let Some(score) = score_frame(model.as_mut(), worker, &frame, source) else {
                        break;
                    };
                    worker.chronological_max_score = Some(
                        worker
                            .chronological_max_score
                            .map_or(score, |max| max.max(score)),
                    );
                    worker.processed_samples += MODEL_FRAME_SAMPLES;
                }
            }
            Message::Finish(session) => {
                let Some(mut worker) = active.take() else {
                    continue;
                };
                if !Arc::ptr_eq(&worker.session, &session) {
                    active = Some(worker);
                    continue;
                }
                let pending_real_samples = worker.pending.len();
                let final_window_attempted = !session.invalid.load(Ordering::Acquire)
                    && !worker.pending.is_empty()
                    && worker.raw_samples >= MODEL_FRAME_SAMPLES;
                let final_window_score = if final_window_attempted {
                    // Pad only the model input. Coverage ends at the last genuine
                    // sample, and already-scored audio is never presented again.
                    let mut frame = [0.0; MODEL_FRAME_SAMPLES];
                    frame[..pending_real_samples].copy_from_slice(&worker.pending);
                    let source = worker.processed_samples..worker.raw_samples;
                    score_frame(model.as_mut(), &mut worker, &frame, source)
                } else {
                    None
                };
                let final_window_status = match (final_window_attempted, final_window_score) {
                    (_, Some(_)) => "scored",
                    (true, None) => "failed",
                    (false, None) => "not-attempted",
                };
                let mut state = session.state.lock().unwrap();
                state.raw_samples = worker.raw_samples;
                state.complete = !session.invalid.load(Ordering::Acquire)
                    && state.covered_samples == worker.raw_samples
                    && worker.raw_samples >= MODEL_FRAME_SAMPLES;
                let reason = match session.invalid_reason.load(Ordering::Acquire) {
                    1 => "queue-or-memory-limit",
                    2 => "cancelled-or-replaced",
                    3 => "invalid-audio-coverage",
                    4 => "invalid-pcm",
                    5 => "model-error",
                    _ if worker.raw_samples < MODEL_FRAME_SAMPLES => "insufficient-real-audio",
                    _ if !state.complete => "incomplete-analysis",
                    _ => "complete",
                };
                log::info!(
                    "[speech-observer] binding={} operation={} raw_samples={} retained_samples={} max_score={:.6} chronological_max_score={:?} final_window_score={:?} final_window_status={} pending_real_samples={} complete={} reason={} init_us={} process_us={}",
                    session.binding_id,
                    session.operation_id,
                    worker.raw_samples,
                    state.retained_samples,
                    state.scores.iter().map(|score| score.value).fold(0.0, f32::max),
                    worker.chronological_max_score,
                    final_window_score,
                    final_window_status,
                    pending_real_samples,
                    state.complete,
                    reason,
                    init_micros,
                    worker.process_micros,
                );
            }
            Message::Retained(session, retained_len, source) => {
                if !active
                    .as_ref()
                    .is_some_and(|worker| Arc::ptr_eq(&worker.session, &session))
                    || session.invalid.load(Ordering::Acquire)
                {
                    continue;
                }
                let mut state = session.state.lock().unwrap();
                if state.retained.len() >= MAX_RETAINED_BLOCKS
                    || state.retained_samples.saturating_add(retained_len) > MAX_SAMPLES
                {
                    session.invalid_reason.store(1, Ordering::Release);
                    session.invalid.store(true, Ordering::Release);
                    continue;
                }
                let start = state.retained_samples;
                state.retained_samples = start + retained_len;
                state.retained.push(RetainedBlock {
                    retained: start..start + retained_len,
                    source,
                });
            }
        }
    }
}

fn score_frame(
    model: Option<&mut vad_rs::Vad>,
    worker: &mut WorkerSession,
    frame: &[f32],
    source: Range<usize>,
) -> Option<f32> {
    let started = Instant::now();
    let score = model
        .and_then(|model| model.compute(frame).ok())
        .map(|result| result.prob);
    worker.process_micros += started.elapsed().as_micros();
    let Some(value) = score.filter(|value| value.is_finite() && (0.0..=1.0).contains(value)) else {
        worker.session.invalid.store(true, Ordering::Release);
        worker.session.invalid_reason.store(5, Ordering::Release);
        return None;
    };
    let mut state = worker.session.state.lock().unwrap();
    if state.scores.len() >= MAX_SCORE_BLOCKS {
        worker.session.invalid.store(true, Ordering::Release);
        worker.session.invalid_reason.store(1, Ordering::Release);
        return None;
    }
    state.covered_samples = state.covered_samples.max(source.end);
    state.scores.push(Score { source, value });
    Some(value)
}
