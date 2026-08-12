import AVFoundation
import Foundation
import MediaToolbox

/// Stereo→mono blender hooked into AVPlayer via MTAudioProcessingTap.
///
/// Stereo recordings in our corpus may carry the original lecture in
/// the left channel and a translation in the right; played as native
/// stereo this is uncomfortable in headphones. The tap walks the PCM
/// frames AVPlayer feeds it and writes a weighted mono mix into both
/// channels:
///
///   ratio = 0.0  → both ears hear the original (left)
///   ratio = 1.0  → both ears hear the translation (right)
///   ratio = 0.5  → balanced mono mix
///
/// Loudness compensation: per-channel weights are normalised by
/// `k = 1 / sqrt((1 − s)² + s²)` so perceived volume stays stable.
///
/// `enabled` and `ratio` live on a heap-allocated context the tap
/// callbacks reach via `MTAudioProcessingTapGetStorage`. The plugin
/// owns one StereoMixTap instance for its lifetime and reuses the
/// same context across all AVPlayerItems, so a setMix() call from
/// the JS bridge takes effect on whatever item is currently bound to
/// the AVPlayer without a player rebuild.
final class StereoMixTap {

    /// Atomic-enough at the granularity we care about: a torn read is
    /// at most a one-frame glitch on transition. We deliberately avoid
    /// locks because the tap process callback is a real-time path.
    fileprivate struct Context {
        var enabled: Bool
        var ratio: Float
    }

    private let contextPointer: UnsafeMutablePointer<Context>

    /// Where an asset's track list is read. For a lecture that isn't
    /// downloaded yet this is a blocking network fetch of the asset header, so
    /// it must never happen on the Capacitor bridge queue (it stalled every
    /// other plugin call in the app — SQLite, Preferences, downloads — for as
    /// long as the fetch took, once per queued item) nor on the main queue.
    ///
    /// Two serial queues rather than one: the item that is about to play must
    /// not wait behind the twenty prefetches a previous queue left behind.
    /// Serial on purpose — the point is to be off the caller's thread, not to
    /// open twenty sockets at once.
    private let nowLoadQueue = DispatchQueue(
        label: "com.shruti.audioplayer.mixload.now", qos: .userInitiated)
    private let aheadLoadQueue = DispatchQueue(
        label: "com.shruti.audioplayer.mixload.ahead", qos: .utility)

    /// Which of the two loading lanes a request belongs in.
    enum LoadPriority {
        /// The item playback is waiting on.
        case now
        /// An item further down the queue, minutes away from its turn.
        case ahead
    }

    init() {
        contextPointer = UnsafeMutablePointer<Context>.allocate(capacity: 1)
        contextPointer.initialize(to: Context(enabled: false, ratio: 0.5))
    }

    deinit {
        contextPointer.deinitialize(count: 1)
        contextPointer.deallocate()
    }

    func setMix(enabled: Bool, ratio: Float) {
        var clamped = ratio
        if clamped.isNaN { clamped = 0.5 }
        if clamped < 0 { clamped = 0 }
        if clamped > 1 { clamped = 1 }
        contextPointer.pointee.enabled = enabled
        contextPointer.pointee.ratio = clamped
    }

    /// Build an AVAudioMix for `asset` off the caller's thread and hand it
    /// back on an arbitrary queue. `nil` means "play the source unchanged".
    ///
    /// The asset's track list is what has to be read, and reading it is the
    /// blocking part; everything after it is cheap and thread-agnostic.
    func loadAudioMix(
        for asset: AVAsset,
        priority: LoadPriority,
        completion: @escaping (AVAudioMix?) -> Void
    ) {
        let queue = priority == .now ? nowLoadQueue : aheadLoadQueue
        queue.async { [weak self] in
            guard let self = self else {
                // The tap context is gone with the instance; a mix pointed at
                // freed storage must never reach an AVPlayerItem.
                completion(nil)
                return
            }
            completion(self.makeAudioMix(for: asset))
        }
    }

    /// Build an AVAudioMix that routes the asset's first audio track
    /// through a fresh MTAudioProcessingTap pointed at our context.
    ///
    /// Blocking: reading `tracks` loads the asset header. Call it through
    /// `loadAudioMix(for:priority:completion:)`, never on the bridge or main
    /// queue.
    ///
    /// Returns nil when:
    ///   - the asset has no audio track (shouldn't happen for our
    ///     corpus)
    ///   - tap creation fails — notably on HLS streams on some iOS
    ///     versions where MTAudioProcessingTap is unsupported. The
    ///     caller falls back to playing the source unchanged.
    private func makeAudioMix(for asset: AVAsset) -> AVAudioMix? {
        let audioTracks = asset.tracks(withMediaType: .audio)
        guard let audioTrack = audioTracks.first else { return nil }

        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(contextPointer),
            init: tapInit,
            finalize: tapFinalize,
            prepare: tapPrepare,
            unprepare: tapUnprepare,
            process: tapProcess
        )

        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(
            kCFAllocatorDefault,
            &callbacks,
            kMTAudioProcessingTapCreationFlag_PreEffects,
            &tap
        )
        guard status == noErr, let tap else {
            return nil
        }

        // The Xcode 26 SDK imports MTAudioProcessingTapCreate as audited, so
        // the +1 from Create is owned by Swift directly — no Unmanaged dance.
        // AVMutableAudioMixInputParameters.audioTapProcessor retains its own
        // reference, so the tap survives as long as the AVPlayerItem holding
        // this audioMix lives — and is released when the item is replaced.
        let inputParams = AVMutableAudioMixInputParameters(track: audioTrack)
        inputParams.audioTapProcessor = tap

        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = [inputParams]
        return audioMix
    }
}

// MARK: - Tap callbacks
//
// These are C function pointers, so they must not capture Swift state.
// We round-trip the StereoMixTap.Context pointer via clientInfo →
// tapStorage and read it from the audio thread via
// MTAudioProcessingTapGetStorage.

private func tapInit(
    _ tap: MTAudioProcessingTap,
    clientInfo: UnsafeMutableRawPointer?,
    tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) {
    tapStorageOut.pointee = clientInfo
}

private func tapFinalize(_ tap: MTAudioProcessingTap) {
    // Context is owned by StereoMixTap (heap-allocated, freed in
    // its deinit). Nothing to free here.
}

private func tapPrepare(
    _ tap: MTAudioProcessingTap,
    maxFrames: CMItemCount,
    processingFormat: UnsafePointer<AudioStreamBasicDescription>
) {}

private func tapUnprepare(_ tap: MTAudioProcessingTap) {}

private func tapProcess(
    _ tap: MTAudioProcessingTap,
    numberFrames: CMItemCount,
    flags: MTAudioProcessingTapFlags,
    bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
    numberFramesOut: UnsafeMutablePointer<CMItemCount>,
    flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>
) {
    // Pull the upstream audio into the bufferList we'll mutate.
    let status = MTAudioProcessingTapGetSourceAudio(
        tap,
        numberFrames,
        bufferListInOut,
        flagsOut,
        nil,
        numberFramesOut
    )
    guard status == noErr else { return }

    let storage = MTAudioProcessingTapGetStorage(tap)
    let ctx = storage.assumingMemoryBound(to: StereoMixTap.Context.self)
    let enabled = ctx.pointee.enabled
    let ratio = ctx.pointee.ratio
    guard enabled else { return }

    let lw = 1.0 - ratio
    let rw = ratio
    let k = 1.0 / sqrt(lw * lw + rw * rw)
    let gL = lw * k
    let gR = rw * k

    let buffers = UnsafeMutableAudioBufferListPointer(bufferListInOut)
    let frames = Int(numberFramesOut.pointee)

    if buffers.count >= 2 {
        // Planar: each channel in its own buffer.
        guard
            let leftRaw = buffers[0].mData,
            let rightRaw = buffers[1].mData
        else { return }
        let left = leftRaw.assumingMemoryBound(to: Float.self)
        let right = rightRaw.assumingMemoryBound(to: Float.self)
        for i in 0..<frames {
            let mono = left[i] * gL + right[i] * gR
            left[i] = mono
            right[i] = mono
        }
    } else if buffers.count == 1 {
        // Interleaved: a single buffer holding [L0 R0 L1 R1 ...].
        // Anything other than 2-channel interleaved we leave alone —
        // the source isn't stereo PCM and there's nothing for us to
        // mix.
        guard buffers[0].mNumberChannels == 2,
              let raw = buffers[0].mData
        else { return }
        let samples = raw.assumingMemoryBound(to: Float.self)
        for i in 0..<frames {
            let L = samples[i * 2]
            let R = samples[i * 2 + 1]
            let mono = L * gL + R * gR
            samples[i * 2] = mono
            samples[i * 2 + 1] = mono
        }
    }
}
