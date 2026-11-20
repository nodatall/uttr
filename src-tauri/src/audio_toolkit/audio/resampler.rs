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
            failed: false,
        }
    }

    pub fn push(&mut self, src: &[f32], mut emit: impl FnMut(&[f32])) {
        self.push_with_validity(src, |frame, _| emit(frame));
    }

    /// `Some(valid)` excludes only zeros appended to complete an output frame.
    /// All available resampler output is observed, including its filtered tail.
    /// An empty frame with `None` reports failure without adding audio. A failure
    /// leaves subsequent coverage unknown.
    pub fn push_with_validity(
        &mut self,
        mut src: &[f32],
        mut emit: impl FnMut(&[f32], Option<usize>),
    ) {
        if self.resampler.is_none() {
            self.emit_frames(src, &mut emit);
            return;
        }

        while !src.is_empty() {
            let space = self.chunk_in - self.in_buf.len();
            let take = space.min(src.len());
            self.in_buf.extend_from_slice(&src[..take]);
            src = &src[take..];

            if self.in_buf.len() == self.chunk_in {
                // let start = std::time::Instant::now();
                if let Ok(out) = self
                    .resampler
                    .as_mut()
                    .unwrap()
                    .process(&[&self.in_buf[..]], None)
                {
                    // let duration = start.elapsed();
                    // log::debug!("Resampler took: {:?}", duration);
                    self.emit_frames(&out[0], &mut emit);
                } else {
                    self.failed = true;
                    emit(&[], None);
                }
                self.in_buf.clear();
            }
        }
    }

    pub fn finish(&mut self, mut emit: impl FnMut(&[f32])) {
        self.finish_with_validity(|frame, _| emit(frame));
    }

    pub fn finish_with_validity(&mut self, mut emit: impl FnMut(&[f32], Option<usize>)) {
        // Process any remaining input samples
        if let Some(ref mut resampler) = self.resampler {
            if !self.in_buf.is_empty() {
                // Pad with zeros to reach chunk size
                self.in_buf.resize(self.chunk_in, 0.0);
                if let Ok(out) = resampler.process(&[&self.in_buf[..]], None) {
                    self.emit_frames(&out[0], &mut emit);
                } else {
                    self.failed = true;
                }
                // Do not resubmit this input. Rubato retains its own delayed audio.
                self.in_buf.clear();
            }
        }

        if self.failed {
            emit(&[], None);
        }

        // Emit any remaining pending frame (padded with zeros)
        if !self.pending.is_empty() {
            let valid = (!self.failed).then_some(self.pending.len());
            self.pending.resize(self.frame_samples, 0.0);
            emit(&self.pending, valid);
            self.pending.clear();
        }
    }

    fn emit_frames(&mut self, mut data: &[f32], emit: &mut impl FnMut(&[f32], Option<usize>)) {
        while !data.is_empty() {
            let space = self.frame_samples - self.pending.len();
            let take = space.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];

            if self.pending.len() == self.frame_samples {
                emit(&self.pending, (!self.failed).then_some(self.pending.len()));
                self.pending.clear();
            }
        }
    }
}
