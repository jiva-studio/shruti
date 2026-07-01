// fluidstreamd — real-time streaming ASR daemon (one process per audio channel).
//
// CONTRACT (frozen — see repo README §protocol):
//   stdin  : raw PCM, signed 16-bit little-endian, mono, 16 kHz — a LIVE stream,
//            written by the client as audio is spoken. Read in chunks, fed at once.
//   stdout : NDJSON, one object per line, flushed as soon as it is produced:
//              {"type":"partial","text":"...","ts_ms":1234}              ← running hypothesis
//              {"type":"final","text":"...","ts_ms":5678,"speaker":"…"}  ← committed speaker turn
//   stderr : human logs only.
//   EOF on stdin → flush the tail, emit final(s), exit 0.
//
// ENGINE: FluidAudio `StreamingNemotronMultilingualAsrManager` — CoreML NVIDIA
// Nemotron 3.5 Streaming Multilingual 0.6B (FastConformer-RNNT, cache-aware TRUE
// streaming on the ANE). We load the full-vocab `multilingual/` variant (Russian +
// English). Language via `--lang` → encoder prompt_id. Chunk tier via `--chunk-ms`.
//
// SPEAKER DIARIZATION: FluidAudio `SortformerDiarizer` (NVIDIA Streaming Sortformer,
// 4 fixed speaker slots, ANE, ~480 ms updates) runs CONCURRENTLY on the SAME PCM.
// It yields a frame-level "who spoke when" timeline. Finals stream INCREMENTALLY:
// as each speaker turn closes mid-stream it is emitted as a `final` tagged with a
// stable `"speaker":"Спикер N"` label. So during a live meeting a speaker's labelled
// final appears shortly after they stop talking, NOT all at once at EOF.
//
// WORD-LEVEL ALIGNMENT (the crux): the ASR transcript LAGS the audio (Nemotron only
// decodes a chunk after it is fully fed, and can fall further behind under load), so
// we must NOT attribute text by "wall/feed time". Instead we use the ASR's own
// per-token timestamps: `getTokenTimings()` returns every decoded token with a
// `startTime` in ABSOLUTE audio-content seconds (encoder-frame index × frame secs)
// — the SAME clock as the diarizer's segment [startTime,endTime]. A finalized
// diarizer segment is BUFFERED until the ASR has decoded a token past its end (so
// its words exist and are stable), then its text is exactly the tokens whose
// timestamp falls in the segment's window. This makes attribution correct at the
// word boundary and immune to however far the ASR lags — a long turn's tail can no
// longer leak into the next speaker.
//
// `ts_ms` on partials is audio-stream (fed) time; on finals it is the diarizer
// segment's start (audio-content time). Both are ms from stream start.
//
// Reference: Sources/FluidAudio/ASR/Parakeet/Streaming/Nemotron/ (getTokenTimings,
//   finishWithTokenTimings, TokenTiming) and Sources/FluidAudio/Diarizer/Sortformer/.

import FluidAudio
import Foundation

// MARK: - CLI

var lang = "ru"        // language hint; mapped to a Nemotron locale below
var chunkMs = 2240     // ASR latency tier (ms): 560 / 1120 / 2240 (default) / 4480
var diarize = true     // run Sortformer speaker diarization concurrently
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--lang":
            if i + 1 < args.count { lang = args[i + 1]; i += 1 }
        case "--chunk-ms":
            if i + 1 < args.count { chunkMs = Int(args[i + 1]) ?? chunkMs; i += 1 }
        case "--no-diarize", "--no-speaker":
            diarize = false
        case "--help", "-h":
            FileHandle.standardError.write(Data(
                "usage: fluidstreamd [--lang <code>] [--chunk-ms 560|1120|2240|4480] [--no-diarize]\n".utf8))
            exit(0)
        default:
            FileHandle.standardError.write(Data("fluidstreamd: ignoring unknown arg \(args[i])\n".utf8))
        }
        i += 1
    }
}

func log(_ msg: String) {
    FileHandle.standardError.write(Data("fluidstreamd: \(msg)\n".utf8))
}

/// Map a short `--lang` code to a full Nemotron locale.
func nemotronLocale(_ code: String) -> String {
    let c = code.lowercased()
    switch c {
    case "ru", "rus", "russian": return "ru-RU"
    case "en", "eng", "english": return "en-US"
    default:
        return code.contains("-") ? code : c
    }
}

// MARK: - NDJSON emitter (thread-safe, unbuffered, ordered)

/// Serializes NDJSON lines to stdout. The partial callback fires on the ASR actor's
/// executor while the read loop runs on the main task, so every write is lock-guarded
/// and flushed immediately. `ts_ms` on partials is derived from `samplesFed`
/// (audio-stream time), keeping one clock across the pipeline.
final class Emitter: @unchecked Sendable {
    private struct Line: Encodable {
        let type: String
        let text: String
        let ts_ms: Int64
        let speaker: String?  // omitted from JSON when nil (synthesized encodeIfPresent)
    }

    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private var lastPartial = ""
    private var samplesFed: Int64 = 0

    private func msLocked() -> Int64 { samplesFed * 1000 / 16000 }

    private func write(_ line: Line) {
        guard var data = try? encoder.encode(line) else { return }
        data.append(0x0A)  // '\n'
        FileHandle.standardOutput.write(data)
    }

    /// Account for PCM samples handed to the engines (advances the audio clock).
    func addFed(_ nSamples: Int) {
        lock.lock(); defer { lock.unlock() }
        samplesFed += Int64(nSamples)
    }

    /// Current audio-stream (fed) time in ms.
    func currentMs() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return msLocked()
    }

    /// Running hypothesis → NDJSON partial. Consecutive duplicates suppressed.
    func partial(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        guard t != lastPartial else { return }
        lastPartial = t
        write(Line(type: "partial", text: t, ts_ms: msLocked(), speaker: nil))
    }

    /// Committed speaker turn. `speaker` is emitted only when non-nil.
    func final(_ text: String, tsMs: Int64, speaker: String? = nil) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        lastPartial = ""
        write(Line(type: "final", text: t, ts_ms: tsMs, speaker: speaker))
    }
}

let emitter = Emitter()

// MARK: - Token-timing → text

/// SentencePiece word-boundary marker ("▁", U+2581); `getTokenTimings()` returns
/// raw pieces so word boundaries can be reconstructed.
let wordMark = "\u{2581}"

/// Reconstruct transcript text from a run of raw SentencePiece tokens: a leading
/// word-mark becomes a space, continuation pieces attach to the previous word.
func joinTokens(_ toks: ArraySlice<TokenTiming>) -> String {
    var s = ""
    for t in toks {
        if t.token.hasPrefix(wordMark) {
            s += " " + t.token.dropFirst()
        } else {
            s += t.token
        }
    }
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - PCM helpers

/// Convert signed-16-bit-LE bytes to normalized 16 kHz mono Float32 samples.
func s16leToFloat(_ bytes: [UInt8]) -> [Float] {
    let sampleCount = bytes.count / 2
    guard sampleCount > 0 else { return [] }
    var out = [Float](repeating: 0, count: sampleCount)
    bytes.withUnsafeBytes { raw in
        for i in 0..<sampleCount {
            let lo = UInt16(raw[2 * i])
            let hi = UInt16(raw[2 * i + 1])
            let s = Int16(bitPattern: lo | (hi << 8))
            out[i] = Float(s) / 32768.0
        }
    }
    return out
}

/// Blocking read of up to `max` bytes from fd 0. Returns nil on EOF/error.
func readStdin(max: Int) -> [UInt8]? {
    var buffer = [UInt8](repeating: 0, count: max)
    let n = buffer.withUnsafeMutableBytes { read(0, $0.baseAddress, max) }
    if n < 0 {
        if errno == EINTR { return [] }  // interrupted — treat as empty read, retry
        log("stdin read error: \(String(cString: strerror(errno)))")
        return nil
    }
    if n == 0 { return nil }  // EOF
    return Array(buffer.prefix(n))
}

// MARK: - Main

let locale = nemotronLocale(lang)
log("starting (lang=\(lang) → locale=\(locale), engine=Nemotron 3.5 Multilingual 0.6B @\(chunkMs)ms, ANE"
    + (diarize ? ", +Sortformer diarization" : "") + ")")

let manager = StreamingNemotronMultilingualAsrManager()

do {
    log("resolving ASR models (downloads multilingual/\(chunkMs)ms on first run)…")
    let variantDir = try await StreamingNemotronMultilingualAsrManager.downloadVariant(
        languageCode: "multilingual", chunkMs: chunkMs)
    try await manager.loadModels(from: variantDir)
    await manager.setLanguage(locale)
    let effMs = await manager.config.chunkMs
    log("ASR models loaded; effective chunk tier = \(effMs)ms")
} catch {
    log("failed to load ASR models: \(error)")
    exit(1)
}

// Sortformer streaming diarizer (concurrent, same PCM). Non-fatal on failure —
// we degrade to ASR-only unlabelled finals.
var diarizer: SortformerDiarizer? = nil
if diarize {
    do {
        let cfg = SortformerConfig.default  // fastV2.1 variant, 4 speakers, ~1.04s latency, ANE
        // sortformerDefault leaves minFramesOn/Off = 0, so single-frame speaker
        // flips become spurious tiny "turns". Require ≥0.25s of speech and bridge
        // ≤0.25s gaps so brief instability doesn't spawn phantom speakers or split a
        // turn; the diarizer drops those frames and their tokens fall to the
        // adjacent turn.
        let tl = DiarizerTimelineConfig(
            numSpeakers: cfg.numSpeakers, frameDurationSeconds: 0.08,
            onsetThreshold: 0.5, offsetThreshold: 0.5,
            onsetPadSeconds: 0, offsetPadSeconds: 0,
            minDurationOn: 0.25, minDurationOff: 0.25)
        let d = SortformerDiarizer(config: cfg, timelineConfig: tl)
        log("resolving Sortformer models (downloads diar-streaming-sortformer-coreml on first run)…")
        let models = try await SortformerModels.loadFromHuggingFace(config: cfg, computeUnits: .all)
        d.initialize(models: models)
        diarizer = d
        log("Sortformer models loaded (4 speaker slots, ~80ms frames)")
        // OPTIONAL ENROLLMENT ("Я" = the user's own voice): before the read loop,
        // load a reference WAV and prime the diarizer so the user's slot is known:
        //     let ref = try AudioConverter().resampleAudioFile("/path/enroll.wav")
        //     _ = try d.enrollSpeaker(withAudio: ref, named: "Я")
        // Then map that speaker's `index` to "Я" in labelFor(...). Wire via a
        // `--enroll <wav>` flag. Optional — generic "Спикер N" labels are the goal.
    } catch {
        log("Sortformer diarization unavailable (\(error)); continuing ASR-only")
        diarizer = nil
    }
}

// Running hypothesis → NDJSON partials (unlabelled, streamed live for the UI).
await manager.setPartialCallback { text in
    emitter.partial(text)
}

// MARK: Attribution state
//
// Finalized diarizer segments are buffered in `pendingSegments` and committed by
// drainPending() once the ASR has decoded a token past a segment's end. Attribution
// walks the ASR token stream once, in order: `committedTokenIdx` is the cursor of
// tokens already emitted; each segment claims the tokens up to its end time.
var labelForSlot: [Int: String] = [:]
var nextLabel = 1
var finalsEmitted = 0
var lastCommittedSlot: Int? = nil
var emittedSegmentIds = Set<UUID>()
var pendingSegments: [DiarizerSegment] = []  // finalized turns awaiting ASR catch-up (time order)
var committedTokenIdx = 0                     // tokens already emitted in a final

/// Stable 1-based label for a Sortformer speaker slot, assigned on first sight.
@MainActor
func labelFor(_ slot: Int) -> String {
    if let l = labelForSlot[slot] { return l }
    let l = "Спикер \(nextLabel)"
    labelForSlot[slot] = l
    nextLabel += 1
    return l
}

/// Emit one `final` for a speaker segment: the uncommitted tokens whose timestamp
/// falls before `endLimitSeconds` (or all remaining tokens when `takeAll`). Advances
/// the token cursor so each word is emitted once. No-op on an empty slice.
@MainActor
func commitSegment(_ seg: DiarizerSegment, tokens: [TokenTiming], endLimitSeconds: Double, takeAll: Bool) {
    var upto = committedTokenIdx
    if takeAll {
        upto = tokens.count
    } else {
        while upto < tokens.count, Double(tokens[upto].startTime) < endLimitSeconds { upto += 1 }
    }
    guard upto > committedTokenIdx else { return }
    let text = joinTokens(tokens[committedTokenIdx..<upto])
    committedTokenIdx = upto
    guard !text.isEmpty else { return }
    emitter.final(text, tsMs: Int64(seg.startTime * 1000), speaker: labelFor(seg.speakerIndex))
    lastCommittedSlot = seg.speakerIndex
    finalsEmitted += 1
}

/// Commit any buffered segment whose words are now fully decoded — i.e. the ASR has
/// produced a token at/after the segment's end (`lastTokenSec >= end`), so the tokens
/// in [prev end, this end) are stable. Slices exactly at the segment's audio-content
/// end, so the boundary word lands in the correct speaker regardless of ASR lag.
@MainActor
func drainPending(tokens: [TokenTiming]) {
    let lastTokenSec = tokens.last.map { Double($0.startTime) } ?? -1
    while let seg = pendingSegments.first {
        guard lastTokenSec >= Double(seg.endTime) else { break }  // ASR not past this end yet
        commitSegment(seg, tokens: tokens, endLimitSeconds: Double(seg.endTime), takeAll: false)
        pendingSegments.removeFirst()
    }
}

// Read live PCM and feed immediately to BOTH engines. `read()` on the input pipe
// returns as much as is buffered (up to this max), so a live stream trickling at
// ~100 ms granularity yields small reads (low latency) while any BACKLOG is coalesced
// into one big read → one `process()` call. That auto-batching keeps the per-call
// ANE/async dispatch cost from letting the pipeline fall behind under load. A stray
// trailing odd byte is carried to the next read so int16 samples never straddle a
// boundary.
let chunkBytes = 32000  // up to ~1 s of s16le@16k per read (coalesces backlog)
var leftover: [UInt8] = []

while let bytes = readStdin(max: chunkBytes) {
    if bytes.isEmpty { continue }  // EINTR retry
    var data = leftover
    data.append(contentsOf: bytes)
    let usable = data.count - (data.count % 2)
    leftover = Array(data[usable...])
    let samples = s16leToFloat(Array(data[..<usable]))
    guard !samples.isEmpty else { continue }

    emitter.addFed(samples.count)  // advance the shared audio clock first

    do {
        _ = try await manager.process(samples: samples)
    } catch {
        log("ASR processing error: \(error)")
    }

    if let d = diarizer {
        do {
            // Each returned `finalizedSegments` entry is a speaker turn that JUST
            // closed. Buffer it; drainPending() commits it once the ASR text for its
            // window has been decoded (may be this iteration or a later one).
            if let update = try d.process(samples: samples, sourceSampleRate: 16000) {
                for seg in update.finalizedSegments.sorted(by: { $0.startFrame < $1.startFrame }) {
                    guard emittedSegmentIds.insert(seg.id).inserted else { continue }
                    pendingSegments.append(seg)
                }
            }
        } catch {
            log("diarization processing error: \(error)")
        }
        if !pendingSegments.isEmpty {
            drainPending(tokens: await manager.getTokenTimings())
        }
    }
}

// EOF → flush the ASR tail. finishWithTokenTimings() returns the full transcript and
// the complete per-token timing stream (getTokenTimings() is cleared by finish()).
let finalText: String
let finalTokens: [TokenTiming]
do {
    (finalText, finalTokens) = try await manager.finishWithTokenTimings()
    if let detected = await manager.detectedLanguage() {
        log("EOF — ASR finished (model-detected language tag: \(detected))")
    } else {
        log("EOF — ASR finished")
    }
} catch {
    log("ASR finish error: \(error)")
    exit(1)
}

let trimmedFinal = finalText.trimmingCharacters(in: .whitespacesAndNewlines)

if let d = diarizer {
    // All tokens now exist, so every buffered turn can be committed.
    drainPending(tokens: finalTokens)
    do {
        _ = try d.finalizeSession()  // promotes the last still-open turn(s) into the timeline
    } catch {
        log("diarization finalize error: \(error)")
    }
    // Any turn not yet committed: segments still buffered (rare after the drain
    // above) plus the last still-open turn(s) finalizeSession() promoted into the
    // timeline (its returned update omits them — documented quirk). Emit in time
    // order; the final segment takes all remaining tokens.
    let tail = d.timeline.speakers.values
        .flatMap { $0.finalizedSegments }
        .filter { !emittedSegmentIds.contains($0.id) }
    let remaining = (pendingSegments + tail).sorted { $0.startFrame < $1.startFrame }
    pendingSegments.removeAll()
    for (i, seg) in remaining.enumerated() {
        let isLast = (i == remaining.count - 1)
        commitSegment(seg, tokens: finalTokens,
            endLimitSeconds: Double(seg.endTime), takeAll: isLast)
    }
}

// Any tokens still uncommitted (trailing words after the last turn, or no diarization
// at all): attribute to the most recent speaker, else emit one unlabelled final.
if committedTokenIdx < finalTokens.count {
    let text = joinTokens(finalTokens[committedTokenIdx..<finalTokens.count])
    if !text.isEmpty {
        emitter.final(text, tsMs: emitter.currentMs(), speaker: lastCommittedSlot.map(labelFor))
        committedTokenIdx = finalTokens.count
        finalsEmitted += 1
    }
} else if finalsEmitted == 0, !trimmedFinal.isEmpty {
    emitter.final(trimmedFinal, tsMs: emitter.currentMs(), speaker: nil)
    finalsEmitted += 1
}

if ProcessInfo.processInfo.environment["FSD_DUMP"] != nil, let d = diarizer {
    for s in d.timeline.speakers.values.flatMap({ $0.finalizedSegments })
        .sorted(by: { $0.startFrame < $1.startFrame }) {
        log(String(format: "SEG spk=%d %.2f–%.2fs", s.speakerIndex, s.startTime, s.endTime))
    }
    var line = ""
    for t in finalTokens { line += String(format: "[%.2f]%@ ", t.startTime, t.token) }
    log("TOKENS: \(line)")
}

log("EOF — \(finalsEmitted) final(s) total, \(labelForSlot.count) distinct speaker(s)")
exit(0)
