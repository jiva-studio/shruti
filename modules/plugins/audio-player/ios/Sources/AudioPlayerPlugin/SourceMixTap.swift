import AVFoundation
import MediaToolbox

/// Source-mix: blend two audio tracks of an AVMutableComposition — the noisy
/// `original` and the denoised `clean` — by per-track gain, driven by a single
/// 0..1 level. Sibling of `StereoMixTap`; same MTAudioProcessingTap pattern,
/// but instead of folding L/R of one stream it scales each composition track:
///
///   level = 0 → original gain 1, clean gain 0   (plays original)
///   level = 1 → original gain 0, clean gain 1   (plays clean)
///   0 < l < 1 → original (1−l), clean (l)        (linear: the signals are
///               near-identical, so they sum to ~constant loudness)
///
/// Both tracks live on one composition timeline → one player clock → inherent
/// sample sync, no manual drift correction (unlike the web fallback).
///
/// The shared `level` lives on a heap context the tap callbacks reach via
/// `MTAudioProcessingTapGetStorage`. The plugin owns one SourceMixTap for its
/// lifetime and updates `level` live from the JS bridge (setSourceMix).
final class SourceMixTap {

    fileprivate struct Context {
        var level: Float
    }

    /// Per-tap client info: which role this tap plays + the shared level.
    fileprivate struct TapInfo {
        let context: UnsafeMutablePointer<Context>
        let isClean: Bool
    }

    private let contextPointer: UnsafeMutablePointer<Context>
    // Kept alive for the plugin's lifetime; each AVPlayerItem rebuild allocates
    // two more. Tiny (≈16 B each) and never freed early — freeing while the
    // audio thread might still hold the pointer would be a use-after-free.
    private var tapInfos: [UnsafeMutablePointer<TapInfo>] = []

    init() {
        contextPointer = UnsafeMutablePointer<Context>.allocate(capacity: 1)
        contextPointer.initialize(to: Context(level: 0))
    }

    deinit {
        contextPointer.deinitialize(count: 1)
        contextPointer.deallocate()
        for info in tapInfos {
            info.deinitialize(count: 1)
            info.deallocate()
        }
    }

    /// Update the live mix level (0 = original, 1 = clean).
    func setLevel(_ level: Float) {
        var l = level
        if l.isNaN { l = 0 }
        if l < 0 { l = 0 }
        if l > 1 { l = 1 }
        contextPointer.pointee.level = l
    }

    /// Build an AVAudioMix with one gain tap per composition track. Returns nil
    /// if tap creation fails (caller plays unmixed).
    func makeAudioMix(
        originalTrack: AVCompositionTrack,
        cleanTrack: AVCompositionTrack
    ) -> AVAudioMix? {
        guard let origParams = makeParams(for: originalTrack, isClean: false),
              let cleanParams = makeParams(for: cleanTrack, isClean: true)
        else { return nil }
        let mix = AVMutableAudioMix()
        mix.inputParameters = [origParams, cleanParams]
        return mix
    }

    private func makeParams(
        for track: AVCompositionTrack,
        isClean: Bool
    ) -> AVMutableAudioMixInputParameters? {
        let info = UnsafeMutablePointer<TapInfo>.allocate(capacity: 1)
        info.initialize(to: TapInfo(context: contextPointer, isClean: isClean))
        tapInfos.append(info)

        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(info),
            init: sourceTapInit,
            finalize: sourceTapFinalize,
            prepare: sourceTapPrepare,
            unprepare: sourceTapUnprepare,
            process: sourceTapProcess
        )
        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(
            kCFAllocatorDefault,
            &callbacks,
            kMTAudioProcessingTapCreationFlag_PreEffects,
            &tap
        )
        guard status == noErr, let tap else { return nil }

        let params = AVMutableAudioMixInputParameters(track: track)
        params.audioTapProcessor = tap
        return params
    }
}

// MARK: - Tap callbacks (C function pointers — no Swift capture).

private func sourceTapInit(
    _ tap: MTAudioProcessingTap,
    clientInfo: UnsafeMutableRawPointer?,
    tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) {
    tapStorageOut.pointee = clientInfo
}

private func sourceTapFinalize(_ tap: MTAudioProcessingTap) {}

private func sourceTapPrepare(
    _ tap: MTAudioProcessingTap,
    maxFrames: CMItemCount,
    processingFormat: UnsafePointer<AudioStreamBasicDescription>
) {}

private func sourceTapUnprepare(_ tap: MTAudioProcessingTap) {}

private func sourceTapProcess(
    _ tap: MTAudioProcessingTap,
    numberFrames: CMItemCount,
    flags: MTAudioProcessingTapFlags,
    bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
    numberFramesOut: UnsafeMutablePointer<CMItemCount>,
    flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>
) {
    let status = MTAudioProcessingTapGetSourceAudio(
        tap, numberFrames, bufferListInOut, flagsOut, nil, numberFramesOut
    )
    guard status == noErr else { return }

    let storage = MTAudioProcessingTapGetStorage(tap)
    let info = storage.assumingMemoryBound(to: SourceMixTap.TapInfo.self)
    let level = info.pointee.context.pointee.level
    let gain: Float = info.pointee.isClean ? level : (1 - level)

    // Scale every sample by this track's gain. Works for any channel layout
    // (clean is mono; original may be mono/stereo). gain==1 is a no-op fast path.
    if gain == 1 { return }
    let buffers = UnsafeMutableAudioBufferListPointer(bufferListInOut)
    let frames = Int(numberFramesOut.pointee)
    for buffer in buffers {
        guard let raw = buffer.mData else { continue }
        let channels = Int(buffer.mNumberChannels)
        let samples = raw.assumingMemoryBound(to: Float.self)
        let count = frames * max(1, channels)
        for i in 0..<count {
            samples[i] *= gain
        }
    }
}
