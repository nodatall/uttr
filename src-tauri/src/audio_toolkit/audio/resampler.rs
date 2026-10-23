use rubato::{FftFixedIn, Resampler};
use std::time::Duration;

// Make this a constant you can tweak
const RESAMPLER_CHUNK_SIZE: usize = 512;

pub struct FrameResampler {
    resampler: Option<FftFixedIn<f32>>,
    chunk_in: usize,
    in_buf: Vec<f32>,
    frame_samples: usize,
    pending: Vec<f32>,
    pending_valid: Vec<bool>,
    pending_uncertain: bool,
    input_hz: usize,
    output_hz: usize,
    input_positions: usize,
    output_positions: usize,
    uncertain_output_until: usize,
    finished_input_buffer: bool,
    failed: bool,
}

impl FrameResampler {
    pub fn new(in_hz: usize, out_hz: usize, frame_dur: Duration) -> Self {
        let frame_samples = ((out_hz as f64 * frame_dur.as_secs_f64()).round()) as usize;
        assert!(frame_samples > 0, "frame duration too short");

        // Use fixed chunk size instead of GCD-based
        let chunk_in = RESAMPLER_CHUNK_SIZE;

        let resampler = (in_hz != out_hz).then(|| {
            FftFixedIn::<f32>::new(in_hz, out_hz, chunk_in, 1, 1)
                .expect("Failed to create resampler")
        });

        Self {
            resampler,
            chunk_in,
            in_buf: Vec::with_capacity(chunk_in),
            frame_samples,
            pending: Vec::with_capacity(frame_samples),
            pending_valid: Vec::with_capacity(frame_samples),
            pending_uncertain: false,
            input_hz: in_hz,
            output_hz: out_hz,
            input_positions: 0,
            output_positions: 0,
            uncertain_output_until: 0,
            finished_input_buffer: false,
            failed: false,
        }
    }

    pub fn push(&mut self, src: &[f32], mut emit: impl FnMut(&[f32])) {
        self.push_with_validity(src, |frame, _| emit(frame));
    }

    pub fn push_with_validity(
        &mut self,
        mut src: &[f32],
        mut emit: impl FnMut(&[f32], Option<usize>),
    ) {
        if self.resampler.is_none() {
            self.emit_frames(src, src.len(), &mut emit);
            return;
        }

        self.input_positions = self.input_positions.saturating_add(src.len());
        while !src.is_empty() {
            let space = self.chunk_in - self.in_buf.len();
            let take = space.min(src.len());
            self.in_buf.extend_from_slice(&src[..take]);
            src = &src[take..];

            if self.in_buf.len() == self.chunk_in {
                self.account_repeated_finish_buffer();
                // let start = std::time::Instant::now();
                if let Ok(out) = self
                    .resampler
                    .as_mut()
                    .unwrap()
                    .process(&[&self.in_buf[..]], None)
                {
                    // let duration = start.elapsed();
                    // log::debug!("Resampler took: {:?}", duration);
                    self.emit_frames(&out[0], out[0].len(), &mut emit);
                } else {
                    self.failed = true;
                }
                self.in_buf.clear();
            }
        }
    }

    pub fn finish(&mut self, mut emit: impl FnMut(&[f32])) {
        self.finish_with_validity(|frame, _| emit(frame));
    }

    pub fn finish_with_validity(&mut self, mut emit: impl FnMut(&[f32], Option<usize>)) {
        self.account_repeated_finish_buffer();
        let real_output_end = self
            .input_positions
            .saturating_mul(self.output_hz)
            .div_ceil(self.input_hz)
            .saturating_add(self.resampler.as_ref().map_or(0, Resampler::output_delay));
        // Process any remaining input samples
        if let Some(ref mut resampler) = self.resampler {
            if !self.in_buf.is_empty() {
                // Pad with zeros to reach chunk size
                let padding = self.chunk_in - self.in_buf.len();
                self.input_positions = self.input_positions.saturating_add(padding);
                self.in_buf.resize(self.chunk_in, 0.0);
                if let Ok(out) = resampler.process(&[&self.in_buf[..]], None) {
                    let valid = real_output_end
                        .saturating_sub(self.output_positions)
                        .min(out[0].len());
                    self.emit_frames(&out[0], valid, &mut emit);
                } else {
                    self.failed = true;
                }
                self.finished_input_buffer = true;
            }
        }

        // Emit any remaining pending frame (padded with zeros)
        if !self.pending.is_empty() {
            let valid = self.valid_prefix();
            self.pending.resize(self.frame_samples, 0.0);
            emit(&self.pending, valid);
            self.pending.clear();
            self.pending_valid.clear();
            self.pending_uncertain = false;
        }
    }

    fn account_repeated_finish_buffer(&mut self) {
        if self.finished_input_buffer {
            // Preserve the capture resampler's existing retained input behavior.
            // Its replayed finish buffer is uncertain for independent evidence.
            self.input_positions = self.input_positions.saturating_add(self.in_buf.len());
            if let Some(resampler) = self.resampler.as_ref() {
                self.uncertain_output_until = self
                    .output_positions
                    .saturating_add(resampler.output_frames_max())
                    .saturating_add(resampler.output_delay().saturating_mul(2));
            }
            self.finished_input_buffer = false;
        }
    }

    fn valid_prefix(&self) -> Option<usize> {
        if self.failed || self.pending_uncertain {
            return None;
        }
        let valid = self
            .pending_valid
            .iter()
            .take_while(|&&valid| valid)
            .count();
        self.pending_valid[valid..]
            .iter()
            .all(|valid| !valid)
            .then_some(valid)
    }

    fn emit_frames(
        &mut self,
        mut data: &[f32],
        mut valid: usize,
        emit: &mut impl FnMut(&[f32], Option<usize>),
    ) {
        while !data.is_empty() {
            let space = self.frame_samples - self.pending.len();
            let take = space.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            self.pending_uncertain |= self.output_positions < self.uncertain_output_until;
            self.pending_valid.extend((0..take).map(|index| {
                index < valid && self.output_positions + index >= self.uncertain_output_until
            }));
            self.output_positions = self.output_positions.saturating_add(take);
            valid = valid.saturating_sub(take);
            data = &data[take..];

            if self.pending.len() == self.frame_samples {
                emit(&self.pending, self.valid_prefix());
                self.pending.clear();
                self.pending_valid.clear();
                self.pending_uncertain = false;
            }
        }
    }
}
