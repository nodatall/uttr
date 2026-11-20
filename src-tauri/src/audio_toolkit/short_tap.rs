use super::constants::WHISPER_SAMPLE_RATE;
use rustfft::{num_complex::Complex32, FftPlanner};
use std::f32::consts::TAU;

const SAMPLE_RATE: usize = WHISPER_SAMPLE_RATE as usize;
const FRAME: usize = SAMPLE_RATE / 50; // 20 ms
const HOP: usize = FRAME / 2;
const CAPTURE_SAMPLES: std::ops::RangeInclusive<usize> = SAMPLE_RATE / 2..=SAMPLE_RATE * 2;

// Called only for a short physical Fn press with a standalone "thank you" result.
pub(crate) fn sounds_like_short_tap(samples: &[f32]) -> bool {
    let Some(last) = samples.iter().rposition(|&s| s != 0.0) else {
        return !samples.is_empty();
    };
    // Uttr pads short uploads with digital silence. Keep the final source hop,
    // but don't let the padding set the background level or establish duration.
    let end = ((last + 1).div_ceil(HOP) * HOP).min(samples.len());
    let audio = &samples[..end];
    // This check is only calibrated for short captures with enough room tone to
    // estimate their background. Fail open before analyzing longer recordings.
    if !CAPTURE_SAMPLES.contains(&audio.len()) {
        return false;
    }
    let mut peak = 0.0_f32;
    let mut sum_squares = 0.0;
    let mut frame_rms = Vec::with_capacity(audio.len().div_ceil(FRAME));
    for frame in audio.chunks(FRAME) {
        let mut energy = 0.0;
        for &sample in frame {
            peak = peak.max(sample.abs());
            energy += sample * sample;
        }
        sum_squares += energy;
        frame_rms.push((energy / frame.len() as f32).sqrt());
    }
    let rms = (sum_squares / audio.len() as f32).sqrt();
    if !quiet_capture(peak, rms) {
        log::debug!(
            "Fn tap audio preserved: samples={} peak={} rms={} reason=audio-levels",
            audio.len(),
            peak,
            rms
        );
        return false;
    }
    // A key or microphone handling impulse can ring for longer than a brief
    // click. Require a single abrupt onset followed by decay, preserving renewed
    // sound such as the second syllable of a softly spoken "thank you".
    if has_decaying_impulse(&frame_rms) {
        log::debug!(
            "Fn tap audio rejected: samples={} reason=decaying-impulse",
            audio.len()
        );
        return true;
    }
    if !has_click_onset(&frame_rms) {
        log::debug!(
            "Fn tap audio preserved: samples={} reason=sustained-or-gradual-sound",
            audio.len()
        );
        return false;
    }

    // Measure speech-band power relative to this capture's own background.
    // Quiet consonants and whispers can be softer than either a key click or room tone.
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FRAME);
    let window: [f32; FRAME] =
        std::array::from_fn(|i| 0.5 - 0.5 * (TAU * i as f32 / (FRAME - 1) as f32).cos());
    let mut buffer = [Complex32::default(); FRAME];
    let mut scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
    let mut power = Vec::with_capacity(audio.len() / HOP);
    for frame in audio.windows(FRAME).step_by(HOP) {
        let mean = frame.iter().sum::<f32>() / FRAME as f32;
        for (i, sample) in frame.iter().enumerate() {
            buffer[i] = Complex32::new((sample - mean) * window[i], 0.0);
        }
        fft.process_with_scratch(&mut buffer, &mut scratch);
        let speech_band = &buffer[250 * FRAME / SAMPLE_RATE..=4000 * FRAME / SAMPLE_RATE];
        power.push(speech_band.iter().map(|bin| bin.norm_sqr()).sum::<f32>());
    }

    // Sum of squared FFT magnitudes for -120 dBFS, with a Hann window.
    let minimum_power = 1e-12 * (FRAME * FRAME) as f32 * 0.375 / 2.0;
    let threshold = 10.0 * background_level(&power).max(minimum_power);
    let reject = has_only_brief_bursts(power.iter().map(|&p| p > threshold));
    log::debug!(
        "Fn tap audio checked: samples={} brief_bursts={}",
        audio.len(),
        reject
    );
    reject
}

fn quiet_capture(peak: f32, rms: f32) -> bool {
    peak <= 0.02 && rms <= 0.0015
}

fn background_level(levels: &[f32]) -> f32 {
    let mut sorted = levels.to_vec();
    sorted.sort_unstable_by(f32::total_cmp);
    let index = (sorted.len() - 1) / 5;
    let fraction = ((sorted.len() - 1) % 5) as f32 / 5.0;
    sorted[index] + fraction * (sorted[index + 1] - sorted[index])
}

fn has_click_onset(frame_rms: &[f32]) -> bool {
    // Room noise can hide quiet syllables in the speech band. Also require an
    // abrupt rise in broadband sound, with at most 180 ms over twice background.
    let background = background_level(frame_rms);
    // A weak excursion above a noisy background cannot establish silence.
    let clear_excursion = frame_rms.iter().any(|&rms| rms > 6.0 * background);
    let has_onset = frame_rms
        .windows(2)
        .any(|pair| pair[1] > 2.5 * pair[0].max(background));
    clear_excursion
        && has_onset
        && frame_rms
            .iter()
            .filter(|&&rms| rms > 2.0 * background)
            .count()
            <= 9
}

fn has_decaying_impulse(frame_rms: &[f32]) -> bool {
    let background = background_level(frame_rms);
    let Some(onset) = frame_rms
        // A 40 ms attack window avoids splitting one impact across frame edges.
        .windows(3)
        .position(|frames| frames[2] > 4.0 * frames[0].max(background))
        .map(|index| index + 2)
    else {
        return false;
    };
    let (peak_index, &peak) = frame_rms
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .unwrap();
    // The impact reaches its peak within 60 ms, lasts at most 300 ms above
    // background, and fades within the captured audio rather than being cut off.
    if peak <= 6.0 * background || peak_index < onset || peak_index - onset > 3
        // An impact can begin near the end of the preceding 20 ms frame.
        || frame_rms[..onset - 1].iter().any(|&level| level > 2.0 * background)
        || frame_rms[onset - 1] > peak * 0.5
        || frame_rms.iter().filter(|&&level| level > 2.0 * background).count() > 15
        || frame_rms.last().copied().unwrap() > peak * 0.25
    {
        return false;
    }
    let tail = &frame_rms[peak_index..];
    if !tail.iter().take(6).any(|&level| level <= peak * 0.5) {
        return false;
    }
    let mut low = peak;
    for &level in tail {
        if level > 1.5 * low.max(background) {
            return false;
        }
        low = low.min(level);
    }
    true
}

fn has_only_brief_bursts(active_hops: impl Iterator<Item = bool>) -> bool {
    let mut run = 0;
    let mut total = 0;
    for active in active_hops {
        if active {
            run += 1;
            total += 1;
            // Keep sustained sound (over 80 ms) or several distinct sounds
            // (over 160 ms total), including speech that started in pre-roll.
            if run > 8 || total > 16 {
                return false;
            }
        } else {
            run = 0;
        }
    }
    // A steady signal without a distinct burst is ambiguous.
    total > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_audio(frame_amplitudes: &[f32]) -> Vec<f32> {
        frame_amplitudes
            .iter()
            .flat_map(|&amplitude| {
                (0..FRAME).map(move |sample| {
                    amplitude * (TAU * 800.0 * sample as f32 / SAMPLE_RATE as f32).cos()
                })
            })
            .collect()
    }

    #[test]
    fn tap_with_a_ringing_tail_is_suppressed() {
        let mut levels = vec![0.0001; 20];
        levels.extend([
            0.0018, 0.0015, 0.0013, 0.0011, 0.0009, 0.0008, 0.0007, 0.0006, 0.0005, 0.0004,
            0.00035, 0.00028, 0.00023, 0.00018, 0.00013, 0.0001,
        ]);
        let samples = synthetic_audio(&levels);
        assert!(!has_click_onset(&levels));
        for shift in [0, 80, 160, 240] {
            for gain in [0.5, 1.0, 2.0] {
                let mut shifted = vec![samples[0] * gain; shift];
                shifted.extend(samples.iter().map(|s| s * gain));
                assert!(sounds_like_short_tap(&shifted), "shift={shift} gain={gain}");
            }
        }
    }

    #[test]
    fn a_quiet_second_burst_keeps_a_recording_eligible() {
        let mut levels = vec![0.0001; 20];
        levels.extend([
            0.0016, 0.0014, 0.0009, 0.0005, 0.00028, 0.00015, 0.00012, 0.0004, 0.00055, 0.0006,
            0.0005, 0.0004, 0.00024, 0.00015, 0.0001,
        ]);
        let samples = synthetic_audio(&levels);
        for gain in [0.01, 0.1, 0.5, 1.0, 2.0] {
            let scaled: Vec<_> = samples.iter().map(|s| s * gain).collect();
            assert!(!sounds_like_short_tap(&scaled), "gain={gain}");
        }
    }

    #[test]
    fn decay_check_preserves_a_second_syllable_or_an_unfinished_sound() {
        let mut levels = vec![0.0001; 20];
        levels.extend([0.001, 0.0014, 0.001, 0.0007, 0.0005, 0.0003, 0.0002]);
        assert!(has_decaying_impulse(&levels));
        let mut unfinished = levels.clone();
        unfinished.truncate(23);
        assert!(!has_decaying_impulse(&unfinished));
        levels.extend([0.0006, 0.0008, 0.0004, 0.0001]);
        assert!(!has_decaying_impulse(&levels));
    }

    #[test]
    fn both_reported_taps_have_only_brief_speech_band_bursts() {
        // Measured before the WAVs expired: retained length, peak, RMS,
        // 20 ms broadband RMS (x 10000), and active 10 ms speech-band hops.
        for (samples, peak, rms, envelope, runs) in [
            (
                16_640,
                0.01086,
                0.00084,
                &[
                    3, 3, 4, 4, 3, 4, 4, 6, 8, 6, 5, 6, 5, 9, 8, 4, 5, 4, 5, 4, 5, 6, 6, 5, 4, 4,
                    5, 5, 4, 4, 4, 4, 4, 4, 4, 3, 4, 3, 3, 6, 4, 4, 3, 3, 3, 14, 7, 8, 8, 21, 43,
                    2,
                ][..],
                &[14..15, 16..19, 21..23, 26..27, 90..91, 96..102][..],
            ),
            (
                9_920,
                0.0101,
                0.00122,
                &[
                    5, 4, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 3, 6, 6, 7, 6, 5, 4, 4, 4, 5, 27, 28, 28,
                    20, 27, 19, 15, 8, 5,
                ][..],
                &[43..47][..],
            ),
        ] {
            assert!(CAPTURE_SAMPLES.contains(&samples));
            assert!(quiet_capture(peak, rms));
            assert!(has_click_onset(
                &envelope
                    .iter()
                    .map(|&v| v as f32 / 10_000.0)
                    .collect::<Vec<_>>()
            ));
            let hop_count = (samples - FRAME) / HOP + 1;
            assert!(has_only_brief_bursts(
                (0..hop_count).map(|i| runs.iter().any(|run| run.contains(&i)))
            ));
        }
    }

    #[test]
    fn preserves_gradual_onsets_and_quiet_syllables_above_room_noise() {
        let mut levels = [0.0004; 30];
        levels[10..15].copy_from_slice(&[0.0006, 0.0009, 0.0013, 0.001, 0.0007]);
        assert!(!has_click_onset(&levels));
        levels[4] = 0.003;
        levels[10..21].fill(0.0009);
        assert!(!has_click_onset(&levels));
    }

    #[test]
    fn preserves_sustained_and_fragmented_activity() {
        assert!(!has_only_brief_bursts([true; 9].into_iter()));
        assert!(!has_only_brief_bursts(
            [true, false].into_iter().cycle().take(34)
        ));
        assert!(!has_only_brief_bursts([false; 40].into_iter()));
    }

    #[test]
    fn padding_cannot_turn_a_brief_speech_fragment_into_a_reliable_capture() {
        let mut samples = vec![0.001; SAMPLE_RATE / 5];
        samples.resize(SAMPLE_RATE * 5 / 4, 0.0);
        assert!(!sounds_like_short_tap(&samples));
    }

    #[test]
    fn quiet_speech_in_pre_roll_survives_a_click_and_padding() {
        let mut samples = vec![0.00001; SAMPLE_RATE];
        for (i, sample) in samples[500..4000].iter_mut().enumerate() {
            *sample += 0.0005 * (TAU * 700.0 * i as f32 / SAMPLE_RATE as f32).sin();
        }
        samples[SAMPLE_RATE * 3 / 4] = 0.013;
        samples.resize(SAMPLE_RATE * 5 / 4, 0.0);
        assert!(!sounds_like_short_tap(&samples));
    }

    #[test]
    fn recognizes_isolated_click_and_digital_silence() {
        let mut samples = vec![0.00001; SAMPLE_RATE];
        samples[SAMPLE_RATE / 2] = 0.012;
        assert!(sounds_like_short_tap(&samples));
        assert!(sounds_like_short_tap(&[0.0; FRAME]));
        assert!(!sounds_like_short_tap(&[]));
        samples[0] = f32::NAN;
        assert!(!sounds_like_short_tap(&samples));
    }
}
