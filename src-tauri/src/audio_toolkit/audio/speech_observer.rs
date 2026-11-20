use ndarray::{Array1, Array2, Array3};
use ort::{session::builder::GraphOptimizationLevel, value::Value};
use std::{
    collections::VecDeque,
    ops::Range,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

const CAPTURE_FRAME_SAMPLES: usize = 480;
const MODEL_FRAME_SAMPLES: usize = 512;
const PHASES: [usize; 8] = [0, 64, 128, 192, 256, 320, 384, 448];
const TERMINAL_FRAMES: usize = 8;
const OUTPUT_WAIT: Duration = Duration::from_millis(100);
const QUEUED_FRAMES: usize = 256;
const MAX_SAMPLES: usize = 16_000 * 60 * 60 * 2;
const MAX_RETAINED_BLOCKS: usize = MAX_SAMPLES / CAPTURE_FRAME_SAMPLES + 32;
// At most one capture frame or one terminal batch can be ahead of other phases.
const MAX_PENDING_SCORES: usize = TERMINAL_FRAMES + 2;

#[derive(Clone, Copy, Debug)]
pub enum SpeechEvidence {
    Unknown,
    Complete { max_score: f32 },
}

#[derive(Default)]
struct EvidenceState {
    retained_blocks: usize,
    retained_samples: usize,
    retained_source_end: usize,
    max_score: f32,
    raw_samples: usize,
    complete: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Completion {
    Pending,
    Finished,
    Invalid,
}

#[derive(Clone, Copy)]
struct FinishReadiness {
    deadline: Instant,
    eligible: bool,
}

struct Session {
    binding_id: String,
    operation_id: u64,
    invalid: AtomicBool,
    invalid_reason: AtomicU8,
    loaded: AtomicBool,
    finish_requested: AtomicBool,
    finish_readiness: Mutex<Option<FinishReadiness>>,
    completion: watch::Sender<Completion>,
    state: Mutex<EvidenceState>,
}

impl Session {
    fn invalidate(&self, reason: u8) {
        let _ =
            self.invalid_reason
                .compare_exchange(0, reason, Ordering::AcqRel, Ordering::Acquire);
        self.invalid.store(true, Ordering::Release);
        self.completion.send_replace(Completion::Invalid);
    }
}

/// One recording's identity and finalized evidence. Capture never waits for inference.
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
        self.session.invalidate(2);
    }

    pub fn whole_recording_evidence(&self) -> SpeechEvidence {
        if self.session.invalid.load(Ordering::Acquire) {
            return SpeechEvidence::Unknown;
        }
        let Ok(state) = self.session.state.try_lock() else {
            return SpeechEvidence::Unknown;
        };
        if !state.complete || self.session.invalid.load(Ordering::Acquire) {
            return SpeechEvidence::Unknown;
        }
        SpeechEvidence::Complete {
            max_score: state.max_score,
        }
    }

    /// The deadline belongs to release, not to the later ASR/output completion.
    /// Return a snapshot so a timeout cannot turn into a rejection after this await.
    pub(crate) async fn output_evidence(&self) -> SpeechEvidence {
        let started = Instant::now();
        let mut completion = self.session.completion.subscribe();
        let readiness = *self.session.finish_readiness.lock().unwrap();
        let status = if self.session.invalid.load(Ordering::Acquire) {
            "invalid"
        } else if *completion.borrow() != Completion::Pending {
            "ready"
        } else if let Some(readiness) = readiness.filter(|readiness| readiness.eligible) {
            let deadline = tokio::time::Instant::from_std(readiness.deadline);
            let completed = tokio::time::timeout_at(deadline, async {
                loop {
                    if *completion.borrow_and_update() != Completion::Pending {
                        break;
                    }
                    if completion.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
            if completed.is_err() {
                "timeout"
            } else {
                "signaled"
            }
        } else {
            "unarmed-or-loading"
        };
        log::info!(
            "[speech-observer-output] operation={} status={} wait_us={}",
            self.session.operation_id,
            status,
            started.elapsed().as_micros()
        );
        if matches!(status, "timeout" | "unarmed-or-loading") {
            SpeechEvidence::Unknown
        } else {
            self.whole_recording_evidence()
        }
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.session.invalidate(1);
        }
    }

    pub(super) fn observe(&self, samples: &[f32], valid_samples: Option<usize>) {
        let Some(valid_samples) = valid_samples.filter(|&valid| valid <= samples.len()) else {
            self.session.invalidate(3);
            return;
        };
        if self.session.finish_requested.load(Ordering::Acquire) {
            self.session.invalidate(3);
            return;
        }
        if self.session.invalid.load(Ordering::Acquire) {
            return;
        }
        for chunk in samples[..valid_samples].chunks(CAPTURE_FRAME_SAMPLES) {
            if chunk.iter().any(|sample| !sample.is_finite()) {
                self.session.invalidate(4);
                return;
            }
            self.send(Message::Samples(self.session.clone(), chunk.to_vec()));
        }
    }

    pub(super) fn retain(&self, retained_len: usize, source: Range<usize>) {
        if retained_len == 0 || self.session.invalid.load(Ordering::Acquire) {
            return;
        }
        if self.session.finish_requested.load(Ordering::Acquire)
            || source.end > MAX_SAMPLES
            || source.start > source.end
            || source.len() > retained_len
        {
            self.session.invalidate(3);
            return;
        }
        self.send(Message::Retained(
            self.session.clone(),
            retained_len,
            source,
        ));
    }

    pub(super) fn finish(&self) {
        let released = Instant::now();
        if self.session.finish_requested.swap(true, Ordering::AcqRel) {
            return;
        }
        let eligible = self.session.loaded.load(Ordering::Acquire)
            && !self.session.invalid.load(Ordering::Acquire);
        *self.session.finish_readiness.lock().unwrap() = Some(FinishReadiness {
            deadline: released + OUTPUT_WAIT,
            eligible,
        });
        log::info!(
            "[speech-observer-finish] operation={} loaded_eligible={} deadline_ms=100",
            self.session.operation_id,
            eligible
        );
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
        let (completion, _) = watch::channel(Completion::Pending);
        let handle = DictationAnalysis {
            session: Arc::new(Session {
                binding_id: binding_id.to_string(),
                operation_id,
                invalid: AtomicBool::new(false),
                invalid_reason: AtomicU8::new(0),
                loaded: AtomicBool::new(false),
                finish_requested: AtomicBool::new(false),
                finish_readiness: Mutex::new(None),
                completion,
                state: Mutex::new(EvidenceState::default()),
            }),
            tx: self.tx.clone(),
        };
        handle.send(Message::Begin(handle.session.clone()));
        handle
    }
}

/// The pinned vad-rs v4 tensor contract, with weights shared by all phase states.
struct Model {
    session: ort::session::Session,
    sample_rate: Array1<i64>,
}

impl Model {
    fn new(path: &Path) -> anyhow::Result<Self> {
        Ok(Self {
            session: ort::session::Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(1)?
                .with_inter_threads(1)?
                .commit_from_file(path)?,
            sample_rate: Array1::from_vec(vec![16_000]),
        })
    }

    fn compute(&mut self, phase: &mut Phase, frame: &[f32]) -> anyhow::Result<f32> {
        let input = Value::from_array(Array2::from_shape_vec(
            (1, MODEL_FRAME_SAMPLES),
            frame.to_vec(),
        )?)?;
        let result = self.session.run(ort::inputs![
            "input" => input,
            "sr" => Value::from_array(self.sample_rate.clone())?,
            "h" => Value::from_array(phase.h.clone())?,
            "c" => Value::from_array(phase.c.clone())?,
        ])?;
        let (_, h) = result["hn"].try_extract_tensor::<f32>()?;
        let (_, c) = result["cn"].try_extract_tensor::<f32>()?;
        let (_, output) = result["output"].try_extract_tensor::<f32>()?;
        let value = *output
            .first()
            .ok_or_else(|| anyhow::anyhow!("empty VAD output"))?;
        anyhow::ensure!(
            value.is_finite() && (0.0..=1.0).contains(&value),
            "invalid VAD probability"
        );
        anyhow::ensure!(
            h.iter().chain(c).all(|value| value.is_finite()),
            "invalid VAD state"
        );
        let next_h = Array3::from_shape_vec((2, 1, 64), h.to_vec())?;
        let next_c = Array3::from_shape_vec((2, 1, 64), c.to_vec())?;
        phase.h = next_h;
        phase.c = next_c;
        Ok(value)
    }
}

struct Score {
    start: i64,
    end: i64,
    value: f32,
}

struct Phase {
    origin: usize,
    h: Array3<f32>,
    c: Array3<f32>,
    pending: Vec<f32>,
    frames: usize,
    covered_samples: usize,
    scores: VecDeque<Score>,
}

impl Phase {
    fn new(origin: usize) -> Self {
        Self {
            origin,
            h: Array3::zeros((2, 1, 64)),
            c: Array3::zeros((2, 1, 64)),
            pending: vec![0.0; origin],
            frames: 0,
            covered_samples: 0,
            scores: VecDeque::with_capacity(MAX_PENDING_SCORES),
        }
    }
}

struct WorkerSession {
    session: Arc<Session>,
    phases: [Phase; 8],
    raw_samples: usize,
    cursor: i64,
    max_score: f64,
    intervals: usize,
    process_micros: u128,
}

impl WorkerSession {
    fn new(session: Arc<Session>) -> Self {
        Self {
            session,
            phases: PHASES.map(Phase::new),
            raw_samples: 0,
            cursor: 0,
            max_score: 0.0,
            intervals: 0,
            process_micros: 0,
        }
    }

    fn score(&mut self, model: &mut Model, index: usize, frame: &[f32], terminal: bool) -> bool {
        let started = Instant::now();
        let phase = &mut self.phases[index];
        let result = model.compute(phase, frame);
        self.process_micros += started.elapsed().as_micros();
        let Ok(value) = result else {
            self.session.invalidate(5);
            return false;
        };
        if phase.scores.len() >= MAX_PENDING_SCORES {
            self.session.invalidate(1);
            return false;
        }
        let start = (phase.frames * MODEL_FRAME_SAMPLES) as i64 - phase.origin as i64;
        let end = start + MODEL_FRAME_SAMPLES as i64;
        phase.frames += 1;
        if !terminal {
            phase.covered_samples = (end.max(0) as usize).min(self.raw_samples);
        }
        phase.scores.push_back(Score { start, end, value });
        self.aggregate();
        true
    }

    fn aggregate(&mut self) {
        loop {
            let mut end = i64::MAX;
            let mut sum = 0.0f64;
            for phase in &mut self.phases {
                while phase
                    .scores
                    .front()
                    .is_some_and(|score| score.end <= self.cursor)
                {
                    phase.scores.pop_front();
                }
                let Some(score) = phase.scores.front() else {
                    return;
                };
                if score.start > self.cursor {
                    return;
                }
                end = end.min(score.end);
                sum += f64::from(score.value);
            }
            self.max_score = self.max_score.max(sum / PHASES.len() as f64);
            self.intervals += 1;
            self.cursor = end;
        }
    }

    fn observe(&mut self, model: &mut Model, samples: &[f32]) {
        if self.raw_samples.saturating_add(samples.len()) > MAX_SAMPLES {
            self.session.invalidate(1);
            return;
        }
        self.raw_samples += samples.len();
        for index in 0..PHASES.len() {
            self.phases[index].pending.extend_from_slice(samples);
            while self.phases[index].pending.len() >= MODEL_FRAME_SAMPLES {
                let frame: Vec<_> = self.phases[index]
                    .pending
                    .drain(..MODEL_FRAME_SAMPLES)
                    .collect();
                if !self.score(model, index, &frame, false) {
                    return;
                }
            }
        }
    }

    fn finish(&mut self, model: &mut Model) {
        if self.raw_samples < MODEL_FRAME_SAMPLES {
            return;
        }
        for index in 0..PHASES.len() {
            if self.session.invalid.load(Ordering::Acquire) {
                return;
            }
            if !self.phases[index].pending.is_empty() {
                let mut frame = [0.0; MODEL_FRAME_SAMPLES];
                let pending = &mut self.phases[index].pending;
                frame[..pending.len()].copy_from_slice(pending);
                pending.clear();
                if !self.score(model, index, &frame, false) {
                    return;
                }
            }
            for _ in 0..TERMINAL_FRAMES {
                if self.session.invalid.load(Ordering::Acquire)
                    || !self.score(model, index, &[0.0; MODEL_FRAME_SAMPLES], true)
                {
                    return;
                }
            }
        }
    }
}

fn run_worker(model_path: PathBuf, rx: mpsc::Receiver<Message>) {
    let mut model: Option<Model> = None;
    let mut active: Option<WorkerSession> = None;
    let mut init_micros = 0;
    while let Ok(message) = rx.recv() {
        match message {
            Message::Begin(session) => {
                if let Some(previous) = active.take() {
                    previous.session.invalidate(2);
                }
                if session.invalid.load(Ordering::Acquire) {
                    continue;
                }
                init_micros = 0;
                if model.is_none() {
                    let started = Instant::now();
                    match Model::new(&model_path) {
                        Ok(loaded) => model = Some(loaded),
                        Err(error) => {
                            log::warn!("Dictation speech observer could not load: {error}");
                            session.invalidate(5);
                        }
                    }
                    init_micros = started.elapsed().as_micros();
                }
                session.loaded.store(model.is_some(), Ordering::Release);
                active = Some(WorkerSession::new(session));
            }
            Message::Samples(session, samples) => {
                if let (Some(worker), Some(model)) = (active.as_mut(), model.as_mut()) {
                    if Arc::ptr_eq(&worker.session, &session)
                        && !session.invalid.load(Ordering::Acquire)
                    {
                        worker.observe(model, &samples);
                    }
                }
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
                if state.retained_blocks >= MAX_RETAINED_BLOCKS
                    || state.retained_samples.saturating_add(retained_len) > MAX_SAMPLES
                {
                    drop(state);
                    session.invalidate(1);
                    continue;
                }
                state.retained_blocks += 1;
                state.retained_samples += retained_len;
                state.retained_source_end = state.retained_source_end.max(source.end);
            }
            Message::Finish(session) => {
                let Some(mut worker) = active.take() else {
                    continue;
                };
                if !Arc::ptr_eq(&worker.session, &session) {
                    active = Some(worker);
                    continue;
                }
                let terminal_started = Instant::now();
                if !session.invalid.load(Ordering::Acquire) {
                    if let Some(model) = model.as_mut() {
                        worker.finish(model);
                    }
                }
                let terminal_micros = terminal_started.elapsed().as_micros();
                let mut state = session.state.lock().unwrap();
                state.raw_samples = worker.raw_samples;
                let covered = worker
                    .phases
                    .iter()
                    .all(|phase| phase.covered_samples == worker.raw_samples);
                if state.retained_source_end > worker.raw_samples
                    || (worker.raw_samples >= MODEL_FRAME_SAMPLES && !covered)
                {
                    drop(state);
                    session.invalidate(3);
                    state = session.state.lock().unwrap();
                }
                state.complete = !session.invalid.load(Ordering::Acquire)
                    && covered
                    && worker.raw_samples >= MODEL_FRAME_SAMPLES
                    && worker.intervals > 0;
                state.max_score = worker.max_score as f32;
                let complete = state.complete;
                let retained_samples = state.retained_samples;
                drop(state);
                // Publish after releasing the evidence lock. A late cancellation still wins.
                if !session.invalid.load(Ordering::Acquire) {
                    session.completion.send_replace(Completion::Finished);
                }
                let reason = match session.invalid_reason.load(Ordering::Acquire) {
                    1 => "queue-or-memory-limit",
                    2 => "cancelled-or-replaced",
                    3 => "invalid-audio-coverage",
                    4 => "invalid-pcm",
                    5 => "model-error",
                    _ if worker.raw_samples < MODEL_FRAME_SAMPLES => "insufficient-real-audio",
                    _ if !complete => "incomplete-analysis",
                    _ => "complete",
                };
                let release_elapsed = session
                    .finish_readiness
                    .lock()
                    .unwrap()
                    .map(|readiness| readiness.deadline - OUTPUT_WAIT)
                    .map(|released| released.elapsed().as_micros());
                log::info!(
                    "[speech-observer] binding={} operation={} raw_samples={} retained_samples={} max_score={:.9} complete={} reason={} init_us={} process_us={} terminal_us={} release_elapsed_us={:?}",
                    session.binding_id, session.operation_id, worker.raw_samples, retained_samples,
                    worker.max_score, complete, reason, init_micros, worker.process_micros,
                    terminal_micros, release_elapsed,
                );
            }
        }
    }
    if let Some(worker) = active {
        worker.session.invalidate(2);
    }
}
