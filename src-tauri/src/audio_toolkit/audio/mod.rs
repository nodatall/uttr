// Re-export all audio components
mod device;
mod import;
mod recorder;
mod resampler;
mod utils;
mod visualizer;

pub use device::{list_input_devices, list_output_devices, CpalDeviceInfo};
pub use import::{import_audio_file, ImportedAudioFile};
pub use recorder::{mix_transcription_pcm_sources, normalize_transcription_pcm};
pub use recorder::{AudioRecorder, DrainResult};
pub use resampler::FrameResampler;
pub use utils::{save_wav_file, trim_proxy_upload_audio};
pub use visualizer::AudioVisualiser;
