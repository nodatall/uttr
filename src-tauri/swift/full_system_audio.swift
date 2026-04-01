import CoreGraphics
import Foundation
import ScreenCaptureKit

private func permissionStateValue(_ state: Int32) -> UttrFullSystemAudioPermissionState {
    return state
}

private func currentScreenRecordingPermissionState() -> UttrFullSystemAudioPermissionState {
    guard CGPreflightScreenCaptureAccess() else {
        return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_NOT_DETERMINED))
    }

    return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_GRANTED))
}

private func requestScreenRecordingPermission() -> UttrFullSystemAudioPermissionState {
    let granted = CGRequestScreenCaptureAccess()
    if granted || CGPreflightScreenCaptureAccess() {
        return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_GRANTED))
    }

    return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_DENIED))
}

private func makeStartResult(
    started: Int32,
    permissionState: Int32
) -> UttrFullSystemAudioStartResult {
    return UttrFullSystemAudioStartResult(
        started: started,
        permission_state: permissionState
    )
}

private func makeStopResult(
    stopped: Int32,
    sampleRate: Int32,
    channelCount: Int32,
    frameCount: Int64
) -> UttrFullSystemAudioStopResult {
    return UttrFullSystemAudioStopResult(
        stopped: stopped,
        sample_rate: sampleRate,
        channel_count: channelCount,
        frame_count: frameCount
    )
}

@_cdecl("uttr_full_system_audio_is_supported")
public func uttrFullSystemAudioIsSupported() -> Int32 {
    if #available(macOS 13.0, *) {
        return 1
    }
    return 0
}

@_cdecl("uttr_full_system_audio_preflight_permission")
public func uttrFullSystemAudioPreflightPermission() -> UttrFullSystemAudioPermissionState {
    if #available(macOS 13.0, *) {
        return currentScreenRecordingPermissionState()
    }
    return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED))
}

@_cdecl("uttr_full_system_audio_request_permission")
public func uttrFullSystemAudioRequestPermission() -> UttrFullSystemAudioPermissionState {
    if #available(macOS 13.0, *) {
        return requestScreenRecordingPermission()
    }
    return permissionStateValue(Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED))
}

@_cdecl("uttr_full_system_audio_start_capture")
public func uttrFullSystemAudioStartCapture(
    _ config: UnsafePointer<UttrFullSystemAudioCaptureConfig>?
) -> UttrFullSystemAudioStartResult {
    if uttrFullSystemAudioIsSupported() == 0 {
        return makeStartResult(
            started: 0,
            permissionState: Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED)
        )
    }

    _ = config
    return makeStartResult(
        started: 0,
        permissionState: Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_NOT_DETERMINED)
    )
}

@_cdecl("uttr_full_system_audio_stop_capture")
public func uttrFullSystemAudioStopCapture() -> UttrFullSystemAudioStopResult {
    return makeStopResult(
        stopped: 0,
        sampleRate: 0,
        channelCount: 0,
        frameCount: 0
    )
}

@_cdecl("uttr_full_system_audio_cancel_capture")
public func uttrFullSystemAudioCancelCapture() {}

@_cdecl("uttr_full_system_audio_cleanup_last_session")
public func uttrFullSystemAudioCleanupLastSession() {}
