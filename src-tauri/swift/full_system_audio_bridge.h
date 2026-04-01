#ifndef full_system_audio_bridge_h
#define full_system_audio_bridge_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t UttrFullSystemAudioPermissionState;

enum {
    UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED = 0,
    UTTR_FULL_SYSTEM_AUDIO_PERMISSION_NOT_DETERMINED = 1,
    UTTR_FULL_SYSTEM_AUDIO_PERMISSION_DENIED = 2,
    UTTR_FULL_SYSTEM_AUDIO_PERMISSION_GRANTED = 3,
    UTTR_FULL_SYSTEM_AUDIO_PERMISSION_ERROR = 4,
};

typedef struct {
    int32_t preferred_sample_rate;
    int32_t preferred_channel_count;
    int32_t capture_microphone;
} UttrFullSystemAudioCaptureConfig;

typedef struct {
    int32_t started;
    int32_t permission_state;
} UttrFullSystemAudioStartResult;

typedef struct {
    float *samples;
    uintptr_t sample_count;
    int32_t sample_rate;
    int32_t channel_count;
} UttrFullSystemAudioPcmBuffer;

typedef struct {
    int32_t stopped;
    int32_t sample_rate;
    int32_t channel_count;
    int64_t frame_count;
    UttrFullSystemAudioPcmBuffer pcm;
} UttrFullSystemAudioStopResult;

int32_t uttr_full_system_audio_is_supported(void);
UttrFullSystemAudioPermissionState uttr_full_system_audio_preflight_permission(void);
UttrFullSystemAudioPermissionState uttr_full_system_audio_request_permission(void);
UttrFullSystemAudioStartResult uttr_full_system_audio_start_capture(
    const UttrFullSystemAudioCaptureConfig *config
);
UttrFullSystemAudioStopResult uttr_full_system_audio_stop_capture(void);
void uttr_full_system_audio_cancel_capture(void);
void uttr_full_system_audio_cleanup_last_session(void);
void uttr_full_system_audio_free_samples(float *samples);

#ifdef __cplusplus
}
#endif

#endif /* full_system_audio_bridge_h */
