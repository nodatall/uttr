mod fn_hold;
mod fn_timing;
mod wire;
pub(crate) use fn_hold::FnPress;
#[cfg(target_os = "macos")]
pub(crate) use fn_timing::FnTimingMonitor;

use crate::{
    byok_secrets, groq_client, managers::audio::AudioRecordingManager, settings::AppSettings,
};
use once_cell::sync::Lazy;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::{
    sync::oneshot,
    task::{AbortHandle, JoinHandle},
    time::timeout,
};
use wire::{Failure, ReadAudio};

#[derive(Clone)]
pub(crate) enum LiveGate {
    Open,
    Fn(Option<FnPress>),
    VerifiedAtRelease(Duration),
}

impl LiveGate {
    fn admitted(&self, start: Instant) -> bool {
        match self {
            Self::Open => true,
            Self::Fn(press) => press.as_ref().is_some_and(|p| p.verified_during(start)),
            Self::VerifiedAtRelease(_) => false,
        }
    }
}

struct Slot {
    recording: Option<Session>,
    abort: AbortHandle,
}

// Cancellation can still abort a socket after the stop task has taken the session.
static SESSIONS: Lazy<Mutex<HashMap<u64, Slot>>> = Lazy::new(Default::default);

pub(crate) struct Session {
    gate: Arc<Mutex<LiveGate>>,
    recording_start: Instant,
    finish: Option<oneshot::Sender<Vec<f32>>>,
    worker: JoinHandle<wire::Result<String>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

impl Session {
    fn freeze_gate(&self, operation: u64) {
        let mut gate = self.gate.lock().unwrap();
        if gate.admitted(self.recording_start) {
            *gate = LiveGate::Open;
            return;
        }
        if let LiveGate::Fn(Some(press)) = &*gate {
            if let Some(hold) = press.verified_at_release(self.recording_start) {
                log::debug!("Scribe Fn hold verified on release operation={operation}");
                *gate = LiveGate::VerifiedAtRelease(hold);
                return;
            }
            press.log_unverified(operation);
        } else {
            log::debug!("Scribe Fn input witness missing operation={operation}");
        }
        *gate = LiveGate::Fn(None);
    }

    pub(crate) fn verified_release_hold(&self) -> Option<Duration> {
        match &*self.gate.lock().unwrap() {
            LiveGate::VerifiedAtRelease(hold) => Some(*hold),
            _ => None,
        }
    }

    pub(crate) async fn finish(mut self, samples: Vec<f32>) -> anyhow::Result<String> {
        {
            let mut gate = self.gate.lock().unwrap();
            let recovered = matches!(&*gate, LiveGate::VerifiedAtRelease(_));
            if !recovered && !gate.admitted(self.recording_start) {
                return Err(anyhow::anyhow!(
                    "Uttr couldn't verify the Fn hold for Scribe. Try the dictation again."
                ));
            }
            if let Some(finish) = self.finish.take() {
                let _ = finish.send(samples);
            }
            // Queue the finalized recording before the worker can connect.
            // A recovered session has no live samples or earlier commits.
            if recovered {
                *gate = LiveGate::Open;
            }
        }
        let result = timeout(Duration::from_secs(20), &mut self.worker)
            .await
            .map_err(|_| Failure::Timeout)
            .and_then(|joined| joined.map_err(|_| Failure::Connection))
            .and_then(|result| result);
        result.map_err(|reason| anyhow::anyhow!(reason.message()))
    }
}

pub(crate) fn start(
    app: &AppHandle,
    settings: AppSettings,
    rm: Arc<AudioRecordingManager>,
    binding: String,
    operation: u64,
    gate: LiveGate,
    recording_start: Instant,
) {
    let app = app.clone();
    spawn_session(
        operation,
        gate,
        recording_start,
        move |receive| async move {
            let mut endpoint = wire::ENDPOINT.to_string();
            if let Some(lang) = groq_client::normalize_language(&settings.selected_language)
                .and_then(|code| code.split('-').next())
                .filter(|code| {
                    (2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase())
                })
            {
                endpoint.push_str("&language_code=");
                endpoint.push_str(lang);
            }
            let key = timeout(
                wire::CONNECT_WAIT,
                tokio::task::spawn_blocking(move || {
                    byok_secrets::load_elevenlabs_api_key(&app, &settings)
                }),
            )
            .await
            .map_err(|_| Failure::Timeout)?
            .map_err(|_| Failure::MissingKey)?
            .map_err(|_| Failure::MissingKey)?
            .ok_or(Failure::MissingKey)?;
            let read: ReadAudio = Arc::new(move |offset| {
                rm.read_dictation_samples(&binding, operation, offset, wire::MAX_PENDING)
            });
            let result = wire::run(&endpoint, &key, read, receive).await;
            if let Ok(text) = &result {
                log::debug!(
                    "Scribe finished operation={operation} empty={}",
                    text.is_empty()
                );
            }
            result
        },
    );
}

fn spawn_session<F, Fut>(operation: u64, gate: LiveGate, recording_start: Instant, connect: F)
where
    F: FnOnce(oneshot::Receiver<Vec<f32>>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = wire::Result<String>> + Send,
{
    if let LiveGate::Fn(Some(press)) = &gate {
        press.arm(recording_start);
    }
    let gate = Arc::new(Mutex::new(gate));
    let (finish, receive) = oneshot::channel();
    let gate_for_worker = gate.clone();
    let worker = tauri::async_runtime::handle().inner().spawn(async move {
        loop {
            {
                let gate = gate_for_worker.lock().unwrap();
                if matches!(&*gate, LiveGate::Fn(None)) {
                    return Ok(String::new());
                }
                if gate.admitted(recording_start) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        log::debug!("Scribe input admitted operation={operation}");
        connect(receive).await
    });
    let abort = worker.abort_handle();
    let session = Session {
        gate,
        recording_start,
        finish: Some(finish),
        worker,
    };
    SESSIONS.lock().unwrap().insert(
        operation,
        Slot {
            recording: Some(session),
            abort,
        },
    );
}

pub(crate) fn take_for_stop(operation: u64) -> Option<Session> {
    let session = SESSIONS
        .lock()
        .unwrap()
        .get_mut(&operation)?
        .recording
        .take()?;
    session.freeze_gate(operation);
    Some(session)
}

pub(crate) fn cancel(operation: u64) {
    if let Some(slot) = SESSIONS.lock().unwrap().remove(&operation) {
        slot.abort.abort();
    }
}
