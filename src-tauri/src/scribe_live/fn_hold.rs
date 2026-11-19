//! A lower bound tied to one raw Fn press. Release debounce and queued hotkey
//! callbacks cannot establish a hold. Only the raw listener's empty poll can.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MIN_HOLD: Duration = Duration::from_millis(200);

type EventCounters = [u32; 3];

#[derive(Clone)]
pub(crate) struct FnPress {
    edge: EventCounters,
    verification: Arc<Mutex<HoldVerification>>,
}

struct HoldVerification {
    recording_start: Instant,
    stable_since: Option<(Instant, EventCounters)>,
    verified_at: Option<Instant>,
    interrupted: bool,
}

impl FnPress {
    pub(crate) fn capture() -> Option<Self> {
        // The native event tap can deliver the edge before Quartz updates its
        // combined-session flags and event counter for that same press.
        let edge = native_event_counters()?;
        Some(Self::new(Instant::now(), edge))
    }

    fn new(began: Instant, edge: EventCounters) -> Self {
        Self {
            edge,
            verification: Arc::new(Mutex::new(HoldVerification {
                recording_start: began,
                stable_since: None,
                verified_at: None,
                interrupted: false,
            })),
        }
    }

    pub(crate) fn on_empty_poll(&self) {
        let started_at = Instant::now();
        if !self.verification.lock().unwrap().needs_observation() {
            return;
        }
        let counters = native_fn_counters();
        let finished_at = Instant::now();
        self.verification
            .lock()
            .unwrap()
            .observe(self.edge, started_at, counters, finished_at);
    }

    #[cfg(test)]
    fn verify(&self, now: Instant, counters: Option<EventCounters>) {
        self.verification
            .lock()
            .unwrap()
            .observe(self.edge, now, counters, now);
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
}

impl HoldVerification {
    fn needs_observation(&self) -> bool {
        !self.interrupted
            && !self
                .verified_at
                .is_some_and(|time| time >= self.recording_start)
    }

    fn observe(
        &mut self,
        edge: EventCounters,
        started_at: Instant,
        counters: Option<EventCounters>,
        finished_at: Instant,
    ) {
        if !self.needs_observation() {
            return;
        }
        let Some(counters) = counters else {
            self.stable_since = None;
            return;
        };
        // A single flag update can be the original Fn-down settling. A release
        // and re-press add at least two updates and must never inherit this press.
        if counters[0].wrapping_sub(edge[0]) > 1 || counters[1..] != edge[1..] {
            self.interrupted = true;
            return;
        }
        match self.stable_since {
            Some((since, confirmed)) if counters == confirmed => {
                if started_at.saturating_duration_since(since) >= MIN_HOLD {
                    self.verified_at = Some(started_at);
                }
            }
            _ => self.stable_since = Some((finished_at, counters)),
        }
    }
}

#[cfg(target_os = "macos")]
fn native_event_counters() -> Option<EventCounters> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCounterForEventType(state: i32, event: u32) -> u32;
    }
    // FlagsChanged, KeyDown, KeyUp in the combined session.
    Some([12, 10, 11].map(|event| unsafe { CGEventSourceCounterForEventType(0, event) }))
}

#[cfg(not(target_os = "macos"))]
fn native_event_counters() -> Option<EventCounters> {
    None
}

#[cfg(target_os = "macos")]
fn native_fn_counters() -> Option<EventCounters> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    // Combined session state includes the modifier transitions used by handy-keys.
    // Read counters on both sides of the state check so a concurrent edge is ambiguous.
    let before = native_event_counters()?;
    const FN: u64 = 1 << 23;
    const MODIFIERS: u64 = FN | (0xf << 17); // Fn, Shift, Control, Option, Command
    let only_fn = unsafe { CGEventSourceFlagsState(0) & MODIFIERS == FN };
    // Sample the physical buttons recognized by handy-keys; some unmodified
    // mouse releases are never delivered to the raw listener.
    let click_held = (0..5).any(|button| unsafe { CGEventSourceButtonState(0, button) });
    if before[0] == 0 || !only_fn || click_held {
        return None;
    }
    (native_event_counters() == Some(before)).then_some(before)
}

#[cfg(not(target_os = "macos"))]
fn native_fn_counters() -> Option<EventCounters> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_a_hold_when_quartz_reports_the_press_after_the_raw_edge() {
        use crate::scribe_live::{cancel, spawn_session, take_for_stop, LiveGate};
        use tokio::sync::oneshot;

        let start = Instant::now();
        let press = FnPress::new(start, [40, 12, 12]);
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

        let settled = [41, 12, 12];
        press.verify(start + Duration::from_millis(5), None);
        press.verify(start + Duration::from_millis(6), Some([40, 12, 12]));
        press.verify(start + Duration::from_millis(10), Some(settled));
        press.verify(start + Duration::from_millis(209), Some(settled));
        assert!(!press.verified_during(start));
        assert_eq!(
            connected.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );

        press.verify(start + Duration::from_millis(210), Some(settled));
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

    // test_disposition: permanent. A delivered release time cannot authorize an upload.
    #[test]
    fn fn_hold_requires_a_continuous_native_press_during_this_recording() {
        let t = Instant::now();
        let counters = [40, 12, 12];
        let press = FnPress::new(t, counters);
        press.verify(t, Some(counters));
        press.verify(t + Duration::from_millis(199), Some(counters));
        press.verify(t + Duration::from_secs(2), None); // up, delivered after a stall
        press.verify(t + Duration::from_secs(2), Some([42, 12, 12])); // release + re-press
        assert!(!press.verified_during(t));
        // A keyboard edge can also interrupt an otherwise settled hold.
        let chord = FnPress::new(t, counters);
        chord.verify(t, Some(counters));
        chord.verify(t + Duration::from_secs(1), Some([40, 13, 13]));
        assert!(!chord.verified_during(t));
        let next = FnPress::new(t, [42, 13, 13]);
        next.verify(t, Some([42, 13, 13]));
        next.verify(t + MIN_HOLD, Some([42, 13, 13]));
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
        let press = FnPress::new(start, [22, 33, 33]);
        let operation = u64::MAX - 200;
        spawn_session(
            operation,
            LiveGate::Fn(Some(press.clone())),
            start,
            move |finish| async move {
                wire::run(&endpoint, "test-local", Arc::new(|_| None), finish).await
            },
        );
        press.verify(start + Duration::from_millis(80), Some([22, 33, 33]));
        press.verify(start + Duration::from_millis(280), None);
        press.verify(start + Duration::from_millis(500), Some([24, 33, 33]));
        let stopped = take_for_stop(operation).unwrap();
        press.verify(start + Duration::from_secs(1), Some([22, 33, 33]));
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
