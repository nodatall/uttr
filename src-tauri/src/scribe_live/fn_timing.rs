//! Release-time confirmation based on a completed macOS Fn gesture.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// The shortcut thread normally polls every 10 ms. Older or ambiguous edges
// cannot be associated with this recording across the two input listeners.
const MAX_SHORTCUT_DELIVERY_DELAY: Duration = Duration::from_millis(40);

#[derive(Clone, Copy)]
pub(super) struct FnEdge {
    pub(super) at: Instant,
    pub(super) timestamp_ns: u64,
}

struct NativeFnPress {
    down: FnEdge,
    clean: bool,
}

#[derive(Default)]
struct FnGestures {
    down: Option<NativeFnPress>,
    completed: Option<(FnEdge, FnEdge)>,
    last_up: Option<Instant>,
}

#[derive(Clone, Default)]
pub(crate) struct FnTiming(Arc<Mutex<FnGestures>>);

impl FnTiming {
    #[cfg(any(target_os = "macos", test))]
    pub(super) fn down(&self, edge: FnEdge, plain_fn: bool) {
        let mut gestures = self.0.lock().unwrap();
        gestures.completed = None;
        if let Some(active) = &mut gestures.down {
            active.clean = false;
            return;
        }
        let away_from_previous_press = gestures.last_up.is_none_or(|previous_up| {
            edge.at
                .checked_duration_since(previous_up)
                .is_some_and(|gap| gap > MAX_SHORTCUT_DELIVERY_DELAY)
        });
        gestures.down = Some(NativeFnPress {
            down: edge,
            clean: plain_fn && away_from_previous_press,
        });
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn interrupt(&self) {
        if let Some(press) = &mut self.0.lock().unwrap().down {
            press.clean = false;
        }
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn up(&self, edge: FnEdge, no_chord: bool) {
        let mut gestures = self.0.lock().unwrap();
        gestures.last_up = Some(edge.at);
        gestures.completed = gestures
            .down
            .take()
            .filter(|press| press.clean && no_chord)
            .map(|press| (press.down, edge));
    }

    #[cfg(any(target_os = "macos", test))]
    pub(super) fn reset(&self) {
        *self.0.lock().unwrap() = FnGestures::default();
    }

    pub(super) fn confirmed_release(
        &self,
        shortcut_down: Instant,
        shortcut_up: Instant,
        recording_start: Instant,
        minimum_hold: Duration,
    ) -> Option<Duration> {
        let (down, up) = self.0.lock().unwrap().completed?;
        let received_edge = |native: FnEdge, shortcut_at: Instant| {
            shortcut_at
                .checked_duration_since(native.at)
                .is_some_and(|delay| delay <= MAX_SHORTCUT_DELIVERY_DELAY)
        };
        if received_edge(down, shortcut_down)
            && received_edge(up, shortcut_up)
            && shortcut_down <= recording_start
            && recording_start < up.at
        {
            let hold = Duration::from_nanos(up.timestamp_ns.checked_sub(down.timestamp_ns)?);
            (hold >= minimum_hold).then_some(hold)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(origin: Instant, ms: u64) -> FnEdge {
        FnEdge {
            at: origin + Duration::from_millis(ms),
            timestamp_ns: 1_000_000_000 + ms * 1_000_000,
        }
    }

    #[test]
    fn late_shortcut_delivery_cannot_make_a_tap_long_enough() {
        let origin = Instant::now();
        let timing = FnTiming::default();
        timing.down(edge(origin, 0), true);
        timing.up(edge(origin, 190), true);
        let result = timing.confirmed_release(
            edge(origin, 5).at,
            edge(origin, 220).at,
            edge(origin, 80).at,
            Duration::from_millis(200),
        );
        assert_eq!(result, None);

        timing.down(edge(origin, 300), true);
        timing.up(edge(origin, 500), true);
        let result = timing.confirmed_release(
            edge(origin, 310).at,
            edge(origin, 510).at,
            edge(origin, 380).at,
            Duration::from_millis(200),
        );
        assert_eq!(result, Some(Duration::from_millis(200)));
    }

    #[test]
    fn accepts_only_a_matching_clean_release_during_the_recording() {
        let origin = Instant::now();
        let timing = FnTiming::default();
        let recorded = edge(origin, 80).at;
        let confirms = |raw_down, raw_up, recorded| {
            timing
                .confirmed_release(
                    edge(origin, raw_down).at,
                    edge(origin, raw_up).at,
                    recorded,
                    Duration::from_millis(200),
                )
                .is_some()
        };
        timing.down(edge(origin, 0), true);
        assert!(!confirms(10, 5100, recorded));
        timing.up(edge(origin, 5090), true);
        assert!(confirms(10, 5100, recorded));
        assert!(!confirms(10, 5190, recorded)); // release sat in the queue
        assert!(!confirms(10, 5100, edge(origin, 5110).at)); // started after release

        // A new press cannot replace this recording's completed hold.
        timing.down(edge(origin, 5101), true);
        assert!(!confirms(10, 5100, recorded));
        timing.up(edge(origin, 5500), true);
        assert!(!confirms(5110, 5510, edge(origin, 5200).at)); // ambiguous re-press

        timing.down(edge(origin, 5600), true);
        timing.interrupt();
        timing.up(edge(origin, 6200), true);
        assert!(!confirms(5610, 6210, edge(origin, 5700).at)); // chord
        timing.down(edge(origin, 6300), true);
        timing.reset();
        timing.up(edge(origin, 6900), true);
        assert!(!confirms(6310, 6910, edge(origin, 6400).at)); // tap lost its event stream
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::FnTimingMonitor;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2_core_foundation::{kCFRunLoopDefaultMode, CFMachPort, CFRunLoop};
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID,
        CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
    };
    use std::{
        ffi::c_void,
        mem::MaybeUninit,
        ptr::NonNull,
        sync::atomic::{AtomicBool, Ordering},
        thread::{self, JoinHandle},
    };

    pub(crate) struct FnTimingMonitor {
        timing: FnTiming,
        running: Arc<AtomicBool>,
        task: Option<JoinHandle<()>>,
    }

    impl FnTimingMonitor {
        pub(crate) fn start() -> Self {
            let timing = FnTiming::default();
            let running = Arc::new(AtomicBool::new(true));
            let thread_timing = timing.clone();
            let thread_running = Arc::clone(&running);
            let task = thread::Builder::new()
                .name("fn-release-events".into())
                .spawn(move || monitor(thread_timing, thread_running))
                .ok();
            Self {
                timing,
                running,
                task,
            }
        }

        pub(crate) fn timing(&self) -> FnTiming {
            self.timing.clone()
        }
    }

    impl Drop for FnTimingMonitor {
        fn drop(&mut self) {
            self.running.store(false, Ordering::Relaxed);
            if let Some(task) = self.task.take() {
                let _ = task.join();
            }
            self.timing.reset();
        }
    }

    fn monitor(timing: FnTiming, running: Arc<AtomicBool>) {
        let timing = Box::new(timing);
        let mask = [
            CGEventType::FlagsChanged,
            CGEventType::KeyDown,
            CGEventType::LeftMouseDown,
            CGEventType::RightMouseDown,
            CGEventType::OtherMouseDown,
        ]
        .into_iter()
        .fold(0, |mask, event| mask | (1 << event.0));
        let Some(tap) = (unsafe {
            CGEvent::tap_create(
                CGEventTapLocation::SessionEventTap,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                mask,
                Some(input),
                (&*timing as *const FnTiming).cast_mut().cast(),
            )
        }) else {
            log::warn!("Could not start the macOS Fn release timer");
            return;
        };
        if let (Some(source), Some(run_loop)) = (
            CFMachPort::new_run_loop_source(None, Some(&tap), 0),
            CFRunLoop::current(),
        ) {
            // The callback's context stays allocated until the tap is invalidated.
            let mode = unsafe { kCFRunLoopDefaultMode };
            run_loop.add_source(Some(&source), mode);
            CGEvent::tap_enable(&tap, true);
            log::debug!("macOS Fn release timer listening");
            while running.load(Ordering::Relaxed) {
                CFRunLoop::run_in_mode(mode, 0.1, false);
                if !CGEvent::tap_is_enabled(&tap) {
                    timing.reset();
                    CGEvent::tap_enable(&tap, true);
                }
            }
            run_loop.remove_source(Some(&source), mode);
        }
        tap.invalidate();
    }

    fn event_edge(event: &CGEvent) -> Option<FnEdge> {
        let timestamp_ns = CGEvent::timestamp(Some(event));
        // Quartz input timestamps use uptime. Bracket the uptime sample to
        // align it conservatively with the shortcut and microphone Instants.
        let mut uptime = MaybeUninit::<libc::timespec>::uninit();
        let before = Instant::now();
        if unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, uptime.as_mut_ptr()) } != 0
            || timestamp_ns == 0
            || before.elapsed() > Duration::from_millis(2)
        {
            return None;
        }
        let uptime = unsafe { uptime.assume_init() };
        let now = Duration::new(
            uptime.tv_sec.try_into().ok()?,
            uptime.tv_nsec.try_into().ok()?,
        );
        let age = now.checked_sub(Duration::from_nanos(timestamp_ns))?;
        Some(FnEdge {
            at: before.checked_sub(age)?,
            timestamp_ns,
        })
    }

    unsafe extern "C-unwind" fn input(
        _proxy: CGEventTapProxy,
        kind: CGEventType,
        event: NonNull<CGEvent>,
        context: *mut c_void,
    ) -> *mut CGEvent {
        let timing = unsafe { &*context.cast::<FnTiming>() };
        if matches!(
            kind,
            CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput
        ) {
            timing.reset();
            return event.as_ptr();
        }

        let input = unsafe { event.as_ref() };
        if kind == CGEventType::FlagsChanged
            && CGEvent::integer_value_field(Some(input), CGEventField::KeyboardEventKeycode) == 0x3f
        {
            let flags = CGEvent::flags(Some(input));
            let fn_down = flags.contains(CGEventFlags::MaskSecondaryFn);
            let chord = flags.intersects(
                CGEventFlags::MaskShift
                    | CGEventFlags::MaskControl
                    | CGEventFlags::MaskAlternate
                    | CGEventFlags::MaskCommand,
            );
            if let Some(edge) = event_edge(input) {
                if fn_down {
                    let mouse_down = (0..5).any(|button| {
                        CGEventSource::button_state(
                            CGEventSourceStateID::CombinedSessionState,
                            objc2_core_graphics::CGMouseButton(button),
                        )
                    });
                    timing.down(edge, !chord && !mouse_down);
                } else {
                    timing.up(edge, !chord);
                }
            } else {
                timing.reset();
            }
        } else {
            timing.interrupt();
        }
        event.as_ptr()
    }
}
