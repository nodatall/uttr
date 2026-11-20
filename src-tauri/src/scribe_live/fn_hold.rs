//! A lower bound tied to one raw Fn press. Release debounce and queued hotkey
//! callbacks cannot establish a hold. Only the raw listener's empty poll can.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::fn_timing::FnTiming;

const MIN_HOLD: Duration = Duration::from_millis(200);

const SESSION_STATE: i32 = 0;
const HARDWARE_STATE: i32 = 1;
const NATIVE_STATES: [i32; 2] = [SESSION_STATE, HARDWARE_STATE];

type EventCounters = [u32; 2];

#[derive(Clone)]
pub(crate) struct FnPress {
    verification: Arc<Mutex<HoldVerification>>,
    release_timing: Option<(FnTiming, Instant)>,
}

struct HoldVerification {
    recording_start: Instant,
    verified_at: Option<Instant>,
    shortcut_up: Option<Instant>,
    sources: [NativeHold; 2],
}

struct NativeHold {
    edge: EventCounters,
    stable_since: Option<(Instant, EventCounters)>,
    interrupted: bool,
    last_observation: Observation,
}

#[derive(Clone, Copy, Debug)]
enum Observation {
    WaitingForFn,
    MouseButtonDown,
    ConcurrentEvent,
    Held(EventCounters),
}

impl FnPress {
    pub(crate) fn capture(timing: Option<FnTiming>, shortcut_down: Instant) -> Option<Self> {
        // The native event tap can deliver the edge before Quartz updates its
        // combined-session flags and event counter for that same press.
        let session = native_event_counters(SESSION_STATE)?;
        let mut hardware = native_event_counters(HARDWARE_STATE)?;
        // Both lanes use the original key-down count even if inputs arrive
        // between the two flag-counter reads.
        hardware[1] = session[1];
        let mut press = Self::new(shortcut_down, [session, hardware]);
        press.release_timing = timing.map(|timing| (timing, shortcut_down));
        Some(press)
    }

    fn new(began: Instant, edges: [EventCounters; 2]) -> Self {
        Self {
            verification: Arc::new(Mutex::new(HoldVerification {
                recording_start: began,
                verified_at: None,
                shortcut_up: None,
                sources: edges.map(|edge| NativeHold {
                    edge,
                    stable_since: None,
                    interrupted: false,
                    last_observation: Observation::WaitingForFn,
                }),
            })),
            release_timing: None,
        }
    }

    pub(crate) fn on_empty_poll(&self) {
        let mut proof = self.verification.lock().unwrap();
        if proof
            .verified_at
            .is_some_and(|t| t >= proof.recording_start)
        {
            return;
        }
        // An unrelated flag in the combined session must not erase a verified
        // uninterrupted hold in the hardware state table.
        for (source, state) in proof.sources.iter_mut().zip(NATIVE_STATES) {
            if source.interrupted {
                continue;
            }
            let started_at = Instant::now();
            let observation = native_fn_observation(state);
            if source.observe(started_at, observation, Instant::now()) {
                proof.verified_at = Some(started_at);
                return;
            }
        }
    }

    #[cfg(test)]
    fn verify(&self, source: usize, now: Instant, counters: Option<EventCounters>) {
        let mut proof = self.verification.lock().unwrap();
        let observation = counters.map_or(Observation::WaitingForFn, Observation::Held);
        if proof.sources[source].observe(now, observation, now) {
            proof.verified_at = Some(now);
        }
    }

    #[cfg(test)]
    pub(super) fn missed_live_hold_for_test(timing: FnTiming, shortcut_down: Instant) -> Self {
        let mut press = Self::new(shortcut_down, [[40, 12], [80, 12]]);
        press.release_timing = Some((timing, shortcut_down));
        press.verify(0, shortcut_down, Some([42, 12]));
        assert!(!press.verified_during(shortcut_down));
        press
    }

    pub(crate) fn arm(&self, recording_start: Instant) {
        self.verification.lock().unwrap().recording_start = recording_start;
    }

    pub(crate) fn verified_during(&self, start: Instant) -> bool {
        self.verification
            .lock()
            .unwrap()
            .verified_at
            .is_some_and(|time| time >= start)
    }

    pub(crate) fn note_shortcut_release(&self, shortcut_up: Instant) {
        self.verification.lock().unwrap().shortcut_up = Some(shortcut_up);
    }

    pub(super) fn verified_at_release(&self, recording_start: Instant) -> Option<Duration> {
        let (timing, shortcut_down) = self.release_timing.as_ref()?;
        let shortcut_up = self.verification.lock().unwrap().shortcut_up?;
        timing.confirmed_release(*shortcut_down, shortcut_up, recording_start, MIN_HOLD)
    }

    pub(crate) fn log_unverified(&self, operation: u64) {
        let proof = self.verification.lock().unwrap();
        let [session, hardware] = &proof.sources;
        log::debug!(
            "Scribe Fn proof missing operation={operation} session={:?} session_interrupted={} hardware={:?} hardware_interrupted={}",
            session.last_observation,
            session.interrupted,
            hardware.last_observation,
            hardware.interrupted,
        );
    }
}

impl NativeHold {
    fn observe(
        &mut self,
        started_at: Instant,
        observation: Observation,
        finished_at: Instant,
    ) -> bool {
        if self.interrupted {
            return false;
        }
        self.last_observation = observation;
        let Observation::Held(counters) = observation else {
            self.stable_since = None;
            return false;
        };
        // A single flag update can be the original Fn-down settling. A release
        // and re-press add at least two updates and must never inherit this press.
        if counters[0].wrapping_sub(self.edge[0]) > 1 || counters[1] != self.edge[1] {
            self.interrupted = true;
            return false;
        }
        match self.stable_since {
            Some((since, confirmed)) if counters == confirmed => {
                started_at.saturating_duration_since(since) >= MIN_HOLD
            }
            _ => {
                self.stable_since = Some((finished_at, counters));
                false
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn native_event_counters(state: i32) -> Option<EventCounters> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCounterForEventType(state: i32, event: u32) -> u32;
    }
    // Track this source's modifier edges, and any new key-down in the session.
    // A release alone can belong to a key that was already down before Fn.
    Some(unsafe {
        [
            CGEventSourceCounterForEventType(state, 12),
            CGEventSourceCounterForEventType(SESSION_STATE, 10),
        ]
    })
}

#[cfg(not(target_os = "macos"))]
fn native_event_counters(_state: i32) -> Option<EventCounters> {
    None
}

#[cfg(target_os = "macos")]
fn native_fn_observation(state: i32) -> Observation {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    let Some(before) = native_event_counters(state) else {
        return Observation::WaitingForFn;
    };
    const FN: u64 = 1 << 23;
    const CHORD_MODIFIERS: u64 = 0xf << 17; // Shift, Control, Option, Command
    let source_flags = unsafe { CGEventSourceFlagsState(state) };
    let session_flags = unsafe { CGEventSourceFlagsState(SESSION_STATE) };
    if before[0] == 0
        || source_flags & FN == 0
        || (source_flags | session_flags) & CHORD_MODIFIERS != 0
    {
        return Observation::WaitingForFn;
    }
    // Sample the physical buttons recognized by handy-keys; some unmodified
    // mouse releases are never delivered to the raw listener.
    if (0..5).any(|button| unsafe { CGEventSourceButtonState(SESSION_STATE, button) }) {
        return Observation::MouseButtonDown;
    }
    // A concurrent modifier or key-down edge invalidates this sample.
    if native_event_counters(state) != Some(before) {
        return Observation::ConcurrentEvent;
    }
    Observation::Held(before)
}

#[cfg(not(target_os = "macos"))]
fn native_fn_observation(_state: i32) -> Observation {
    Observation::WaitingForFn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_a_hold_when_quartz_reports_the_press_after_the_raw_edge() {
        use crate::scribe_live::{cancel, spawn_session, take_for_stop, LiveGate};
        use tokio::sync::oneshot;

        let start = Instant::now();
        let press = FnPress::new(start, [[40, 12], [80, 12]]);
        let operation = u64::MAX - 201;
        let (started, mut connected) = oneshot::channel();
        spawn_session(
            operation,
            LiveGate::Fn(Some(press.clone())),
            start,
            |finish| async move {
                started.send(()).unwrap();
                assert_eq!(finish.await.unwrap().len(), 16_000);
                Ok("test dictation".into())
            },
        );

        let settled = [41, 12];
        press.verify(0, start + Duration::from_millis(5), None);
        press.verify(0, start + Duration::from_millis(6), Some([40, 12]));
        press.verify(0, start + Duration::from_millis(10), Some(settled));
        press.verify(0, start + Duration::from_millis(209), Some(settled));
        assert!(!press.verified_during(start));
        assert_eq!(
            connected.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );

        press.verify(0, start + Duration::from_millis(210), Some(settled));
        assert!(press.verified_during(start));
        tokio::time::timeout(Duration::from_secs(1), connected)
            .await
            .unwrap()
            .unwrap();
        let stopped = take_for_stop(operation).unwrap();
        assert_eq!(
            stopped.finish(vec![0.02; 16_000]).await.unwrap(),
            "test dictation"
        );
        cancel(operation);
    }

    #[test]
    fn hardware_hold_can_confirm_when_the_session_flags_are_noisy() {
        let t = Instant::now();
        let press = FnPress::new(t, [[40, 12], [80, 12]]);
        press.verify(0, t, Some([42, 12]));
        press.verify(0, t + MIN_HOLD, Some([42, 12]));
        press.verify(1, t, Some([81, 12]));
        press.verify(1, t + MIN_HOLD - Duration::from_millis(1), Some([81, 12]));
        assert!(!press.verified_during(t));
        press.verify(1, t + MIN_HOLD, Some([81, 12]));
        assert!(press.verified_during(t));
    }

    // test_disposition: permanent. A delivered release time cannot authorize an upload.
    #[test]
    fn fn_hold_requires_a_continuous_native_press_during_this_recording() {
        let t = Instant::now();
        let counters = [40, 12];
        let press = FnPress::new(t, [counters; 2]);
        for source in 0..2 {
            press.verify(source, t, Some(counters));
            press.verify(source, t + Duration::from_millis(199), Some(counters));
            press.verify(source, t + Duration::from_secs(2), None);
            // A delayed release and subsequent re-press aren't the same hold.
            press.verify(source, t + Duration::from_secs(2), Some([42, 12]));
        }
        assert!(!press.verified_during(t));
        // A keyboard edge can also interrupt an otherwise settled hold.
        let chord = FnPress::new(t, [counters; 2]);
        for source in 0..2 {
            chord.verify(source, t, Some(counters));
            chord.verify(source, t + Duration::from_secs(1), Some([40, 13]));
        }
        assert!(!chord.verified_during(t));
        let next = FnPress::new(t, [[42, 13]; 2]);
        next.verify(0, t, Some([42, 13]));
        next.verify(0, t + MIN_HOLD, Some([42, 13]));
        assert!(next.verified_during(t));
        assert!(!next.verified_during(t + Duration::from_secs(1)));
        assert!(!press.verified_during(t));
    }

    // test_disposition: permanent. A tap must not even open a provider connection at stop.
    #[tokio::test]
    async fn queued_tap_and_second_press_cannot_connect_on_release() {
        use crate::scribe_live::{cancel, spawn_session, take_for_stop, wire, LiveGate};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let start = Instant::now();
        let press = FnPress::new(start, [[22, 33]; 2]);
        let operation = u64::MAX - 200;
        spawn_session(
            operation,
            LiveGate::Fn(Some(press.clone())),
            start,
            move |finish| async move {
                wire::run(&endpoint, "test-local", Arc::new(|_| None), finish, None).await
            },
        );
        for source in 0..2 {
            press.verify(source, start + Duration::from_millis(80), Some([22, 33]));
            press.verify(source, start + Duration::from_millis(280), None);
            press.verify(source, start + Duration::from_millis(500), Some([24, 33]));
        }
        let stopped = take_for_stop(operation).unwrap();
        press.verify(0, start + Duration::from_secs(1), Some([22, 33]));
        assert!(stopped
            .finish(vec![0.02; 16000])
            .await
            .unwrap_err()
            .to_string()
            .contains("verify the Fn hold"));
        cancel(operation);
        assert!(
            tokio::time::timeout(Duration::from_millis(60), listener.accept())
                .await
                .is_err()
        );
    }
}
