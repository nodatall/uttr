import AudioToolbox
import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let activeSessionLock = NSLock()
private var activeSession: AnyObject?

private func permissionStateValue(_ state: Int32) -> UttrFullSystemAudioPermissionState {
    state
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
    UttrFullSystemAudioStartResult(
        started: started,
        permission_state: permissionState
    )
}

private func makeStopResult(
    stopped: Int32,
    sampleRate: Int32,
    channelCount: Int32,
    frameCount: Int64,
    pcm: UttrFullSystemAudioPcmBuffer
) -> UttrFullSystemAudioStopResult {
    UttrFullSystemAudioStopResult(
        stopped: stopped,
        sample_rate: sampleRate,
        channel_count: channelCount,
        frame_count: frameCount,
        pcm: pcm
    )
}

private func makeEmptyPcmBuffer(
    sampleRate: Int32 = 0,
    channelCount: Int32 = 0
) -> UttrFullSystemAudioPcmBuffer {
    UttrFullSystemAudioPcmBuffer(
        samples: nil,
        sample_count: 0,
        sample_rate: sampleRate,
        channel_count: channelCount
    )
}

private func makePcmBuffer(
    samples: [Float],
    sampleRate: Int32,
    channelCount: Int32
) -> UttrFullSystemAudioPcmBuffer {
    guard !samples.isEmpty else {
        return makeEmptyPcmBuffer(sampleRate: sampleRate, channelCount: channelCount)
    }

    let byteCount = samples.count * MemoryLayout<Float>.stride
    guard let rawPointer = malloc(byteCount) else {
        return makeEmptyPcmBuffer(sampleRate: sampleRate, channelCount: channelCount)
    }

    let samplePointer = rawPointer.assumingMemoryBound(to: Float.self)
    samples.withUnsafeBufferPointer { buffer in
        guard let sourcePointer = buffer.baseAddress else { return }
        samplePointer.initialize(from: sourcePointer, count: samples.count)
    }

    return UttrFullSystemAudioPcmBuffer(
        samples: samplePointer,
        sample_count: UInt(samples.count),
        sample_rate: sampleRate,
        channel_count: channelCount
    )
}

@available(macOS 13.0, *)
private final class FullSystemAudioCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputQueue = DispatchQueue(label: "uttr.full_system_audio.output")
    private let stateLock = NSLock()
    private var stream: SCStream?
    private var capturedSamples: [Float] = []
    private var capturedSampleRate: Int32 = 0
    private var capturedChannelCount: Int32 = 0

    func start(config: UttrFullSystemAudioCaptureConfig) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var didStart = false

        Task {
            defer { semaphore.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false,
                    onScreenWindowsOnly: true
                )
                guard let display = content.displays.first else {
                    return
                }

                let filter = SCContentFilter(
                    display: display,
                    excludingApplications: [],
                    exceptingWindows: []
                )

                let streamConfiguration = SCStreamConfiguration()
                streamConfiguration.capturesAudio = true
                streamConfiguration.excludesCurrentProcessAudio = true
                streamConfiguration.queueDepth = 3

                if config.preferred_sample_rate > 0 {
                    streamConfiguration.sampleRate = Int(config.preferred_sample_rate)
                }

                if config.preferred_channel_count > 0 {
                    streamConfiguration.channelCount = Int(config.preferred_channel_count)
                }

                let stream = SCStream(
                    filter: filter,
                    configuration: streamConfiguration,
                    delegate: self
                )
                try stream.addStreamOutput(
                    self,
                    type: .audio,
                    sampleHandlerQueue: outputQueue
                )
                try await stream.startCapture()

                stateLock.lock()
                self.stream = stream
                stateLock.unlock()
                didStart = true
            } catch {
                didStart = false
            }
        }

        semaphore.wait()
        return didStart
    }

    func stop() -> UttrFullSystemAudioStopResult {
        stopStream()

        let snapshot = takeSnapshot()
        let frameCount = snapshot.channelCount > 0
            ? Int64(snapshot.samples.count / Int(snapshot.channelCount))
            : 0

        return makeStopResult(
            stopped: 1,
            sampleRate: snapshot.sampleRate,
            channelCount: snapshot.channelCount,
            frameCount: frameCount,
            pcm: makePcmBuffer(
                samples: snapshot.samples,
                sampleRate: snapshot.sampleRate,
                channelCount: snapshot.channelCount
            )
        )
    }

    func cancel() {
        stopStream()
        clearSamples()
    }

    func cleanup() {
        clearSamples()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stateLock.lock()
        self.stream = nil
        stateLock.unlock()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio else {
            return
        }

        appendAudio(from: sampleBuffer)
    }

    private func stopStream() {
        let semaphore = DispatchSemaphore(value: 0)
        var streamToStop: SCStream?

        stateLock.lock()
        streamToStop = stream
        stream = nil
        stateLock.unlock()

        guard let stream = streamToStop else {
            return
        }

        Task {
            defer { semaphore.signal() }
            do {
                try await stream.stopCapture()
            } catch {
            }
        }

        semaphore.wait()
    }

    private func clearSamples() {
        stateLock.lock()
        capturedSamples.removeAll(keepingCapacity: false)
        capturedSampleRate = 0
        capturedChannelCount = 0
        stateLock.unlock()
    }

    private func takeSnapshot() -> (samples: [Float], sampleRate: Int32, channelCount: Int32) {
        stateLock.lock()
        let snapshot = (
            samples: capturedSamples,
            sampleRate: capturedSampleRate,
            channelCount: max(capturedChannelCount, 1)
        )
        capturedSamples.removeAll(keepingCapacity: false)
        capturedSampleRate = 0
        capturedChannelCount = 0
        stateLock.unlock()
        return snapshot
    }

    private func appendAudio(from sampleBuffer: CMSampleBuffer) {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescriptionPointer =
                CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            return
        }

        let streamDescription = streamDescriptionPointer.pointee
        let channelCount = max(Int(streamDescription.mChannelsPerFrame), 1)
        let audioBufferListSize = MemoryLayout<AudioBufferList>.size
            + max(0, channelCount - 1) * MemoryLayout<AudioBuffer>.size
        let audioBufferListPointer = UnsafeMutableRawPointer.allocate(
            byteCount: audioBufferListSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { audioBufferListPointer.deallocate() }

        let audioBufferList = audioBufferListPointer.bindMemory(
            to: AudioBufferList.self,
            capacity: 1
        )
        var blockBuffer: CMBlockBuffer?

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: audioBufferList,
            bufferListSize: audioBufferListSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else {
            return
        }

        let frameCount = Int(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0 else {
            return
        }

        let formatFlags = streamDescription.mFormatFlags
        let bitsPerChannel = Int(streamDescription.mBitsPerChannel)
        let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
        guard !buffers.isEmpty else {
            return
        }

        let samples: [Float]
        if buffers.count > 1 {
            samples = deinterleaveSamples(
                buffers: buffers,
                frameCount: frameCount,
                bitsPerChannel: bitsPerChannel,
                formatFlags: formatFlags
            )
        } else {
            samples = flattenInterleavedSamples(
                buffer: buffers[0],
                frameCount: frameCount,
                channelCount: channelCount,
                bitsPerChannel: bitsPerChannel,
                formatFlags: formatFlags
            )
        }

        guard !samples.isEmpty else {
            return
        }

        stateLock.lock()
        capturedSamples.append(contentsOf: samples)
        if capturedSampleRate == 0 {
            capturedSampleRate = Int32(streamDescription.mSampleRate.rounded())
        }
        if capturedChannelCount == 0 {
            capturedChannelCount = Int32(channelCount)
        }
        stateLock.unlock()
    }
}

@available(macOS 13.0, *)
private func deinterleaveSamples(
    buffers: UnsafeMutableAudioBufferListPointer,
    frameCount: Int,
    bitsPerChannel: Int,
    formatFlags: AudioFormatFlags
) -> [Float] {
    let channelCount = buffers.count
    var samples = [Float]()
    samples.reserveCapacity(frameCount * channelCount)

    if formatFlags & kAudioFormatFlagIsFloat != 0 && bitsPerChannel == 32 {
        for frameIndex in 0..<frameCount {
            for channelIndex in 0..<channelCount {
                guard let baseAddress = buffers[channelIndex].mData?
                    .assumingMemoryBound(to: Float.self)
                else {
                    return []
                }
                samples.append(baseAddress[frameIndex])
            }
        }
        return samples
    }

    if formatFlags & kAudioFormatFlagIsSignedInteger != 0 && bitsPerChannel == 16 {
        for frameIndex in 0..<frameCount {
            for channelIndex in 0..<channelCount {
                guard let baseAddress = buffers[channelIndex].mData?
                    .assumingMemoryBound(to: Int16.self)
                else {
                    return []
                }
                samples.append(Float(baseAddress[frameIndex]) / Float(Int16.max))
            }
        }
        return samples
    }

    if formatFlags & kAudioFormatFlagIsSignedInteger != 0 && bitsPerChannel == 32 {
        for frameIndex in 0..<frameCount {
            for channelIndex in 0..<channelCount {
                guard let baseAddress = buffers[channelIndex].mData?
                    .assumingMemoryBound(to: Int32.self)
                else {
                    return []
                }
                samples.append(Float(baseAddress[frameIndex]) / Float(Int32.max))
            }
        }
        return samples
    }

    return []
}

@available(macOS 13.0, *)
private func flattenInterleavedSamples(
    buffer: AudioBuffer,
    frameCount: Int,
    channelCount: Int,
    bitsPerChannel: Int,
    formatFlags: AudioFormatFlags
) -> [Float] {
    let sampleCount = frameCount * channelCount
    guard let data = buffer.mData else {
        return []
    }

    if formatFlags & kAudioFormatFlagIsFloat != 0 && bitsPerChannel == 32 {
        let pointer = data.assumingMemoryBound(to: Float.self)
        return Array(UnsafeBufferPointer(start: pointer, count: sampleCount))
    }

    if formatFlags & kAudioFormatFlagIsSignedInteger != 0 && bitsPerChannel == 16 {
        let pointer = data.assumingMemoryBound(to: Int16.self)
        return Array(UnsafeBufferPointer(start: pointer, count: sampleCount))
            .map { Float($0) / Float(Int16.max) }
    }

    if formatFlags & kAudioFormatFlagIsSignedInteger != 0 && bitsPerChannel == 32 {
        let pointer = data.assumingMemoryBound(to: Int32.self)
        return Array(UnsafeBufferPointer(start: pointer, count: sampleCount))
            .map { Float($0) / Float(Int32.max) }
    }

    return []
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
    guard uttrFullSystemAudioIsSupported() == 1 else {
        return makeStartResult(
            started: 0,
            permissionState: Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED)
        )
    }

    let permissionState = currentScreenRecordingPermissionState()
    guard permissionState == Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_GRANTED) else {
        return makeStartResult(started: 0, permissionState: permissionState)
    }

    guard #available(macOS 13.0, *) else {
        return makeStartResult(
            started: 0,
            permissionState: Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_UNSUPPORTED)
        )
    }

    let captureConfig = config?.pointee ?? UttrFullSystemAudioCaptureConfig(
        preferred_sample_rate: 16_000,
        preferred_channel_count: 2,
        capture_microphone: 0
    )

    activeSessionLock.lock()
    let existingSession = activeSession
    activeSessionLock.unlock()

    guard existingSession == nil else {
        return makeStartResult(started: 0, permissionState: permissionState)
    }

    let session = FullSystemAudioCaptureSession()
    let started = session.start(config: captureConfig)
    if started {
        activeSessionLock.lock()
        activeSession = session
        activeSessionLock.unlock()
    }

    return makeStartResult(
        started: started ? 1 : 0,
        permissionState: started
            ? Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_GRANTED)
            : Int32(UTTR_FULL_SYSTEM_AUDIO_PERMISSION_ERROR)
    )
}

@_cdecl("uttr_full_system_audio_stop_capture")
public func uttrFullSystemAudioStopCapture() -> UttrFullSystemAudioStopResult {
    guard #available(macOS 13.0, *) else {
        return makeStopResult(
            stopped: 0,
            sampleRate: 0,
            channelCount: 0,
            frameCount: 0,
            pcm: makeEmptyPcmBuffer()
        )
    }

    activeSessionLock.lock()
    let session = activeSession as? FullSystemAudioCaptureSession
    activeSession = nil
    activeSessionLock.unlock()

    guard let session else {
        return makeStopResult(
            stopped: 0,
            sampleRate: 0,
            channelCount: 0,
            frameCount: 0,
            pcm: makeEmptyPcmBuffer()
        )
    }

    return session.stop()
}

@_cdecl("uttr_full_system_audio_cancel_capture")
public func uttrFullSystemAudioCancelCapture() {
    guard #available(macOS 13.0, *) else {
        return
    }

    activeSessionLock.lock()
    let session = activeSession as? FullSystemAudioCaptureSession
    activeSession = nil
    activeSessionLock.unlock()

    session?.cancel()
}

@_cdecl("uttr_full_system_audio_cleanup_last_session")
public func uttrFullSystemAudioCleanupLastSession() {
    guard #available(macOS 13.0, *) else {
        return
    }

    activeSessionLock.lock()
    let session = activeSession as? FullSystemAudioCaptureSession
    activeSessionLock.unlock()

    session?.cleanup()
}

@_cdecl("uttr_full_system_audio_free_samples")
public func uttrFullSystemAudioFreeSamples(_ samples: UnsafeMutablePointer<Float>?) {
    guard let samples else { return }
    free(samples)
}
