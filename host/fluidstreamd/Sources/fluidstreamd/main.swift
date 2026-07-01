// fluidstreamd — real-time streaming ASR daemon (one process per audio channel).
//
// CONTRACT (frozen — see repo README §protocol):
//   stdin  : raw PCM, signed 16-bit little-endian, mono, 16 kHz — a LIVE stream,
//            written by the client as audio is spoken (NOT a pre-recorded file
//            handed over at the end). Read in small chunks and fed immediately.
//   stdout : NDJSON, one object per line, flushed as soon as it is produced:
//              {"type":"partial","text":"...","ts_ms":1234}              ← running hypothesis
//              {"type":"final","text":"...","ts_ms":5678,"speaker":"…"}  ← committed segment(s) at EOF
//   stderr : human logs only.
//   EOF on stdin → flush the tail via finish(), emit final(s), exit 0.
//
// ENGINE: FluidAudio `StreamingNemotronMultilingualAsrManager` — the CoreML build
// of NVIDIA Nemotron 3.5 ASR Streaming Multilingual 0.6B (FastConformer-RNNT,
// cache-aware TRUE streaming on the Apple Neural Engine). We always load the
// full-vocab `multilingual/` variant (NOT `latin/`, which prunes Cyrillic and
// cannot do Russian). Language is selected per-process via `--lang` → the encoder
// `prompt_id`. Chunk/latency tier default: 2240 ms.
//
// SPEAKER DIARIZATION (added): FluidAudio's `SortformerDiarizer` (NVIDIA Streaming
// Sortformer, 4 fixed speaker slots, ANE, ~480 ms updates) runs CONCURRENTLY on
// the SAME PCM samples. It maintains a frame-level "who spoke when" timeline in
// audio time. Finals stream INCREMENTALLY: each time a speaker segment finalizes
// mid-stream (`process()` → `update.finalizedSegments`), we immediately emit one
// `final` tagged with a stable `"speaker":"Спикер N"` label, whose text is the
// slice of the running ASR hypothesis over that segment's [startTime, endTime]
// window. A commit cursor guarantees each word is emitted once. The last still-open
// turn is flushed at EOF. So during a live meeting a speaker's labelled final
// appears ~1-2 s after they stop talking, NOT all at once at the end.
//
// CLOCK NOTE: `ts_ms` is AUDIO-STREAM time — milliseconds of PCM fed so far
// (samplesFed / 16). For a genuine live capture this equals wall-clock ms since
// start; for a file piped faster than real time it is the true audio position.
// Using audio time (not wall clock) is what lets the ASR hypothesis timeline and
// the Sortformer segment timeline share ONE clock so they can be correlated.
//
// NOTE ON FINALS: Nemotron has no end-of-utterance token, so the ASR itself never
// segments — it streams partials continuously and yields the full committed
// transcript only at EOF. The DIARIZER is therefore the segmenter: each closed
// speaker turn commits the hypothesis grown since the previous commit as one
// labelled `final`, live. If diarization is disabled or finds no speech, behaviour
// degrades to the old single unlabelled final at EOF.
//
// Reference: Sources/FluidAudio/ASR/Parakeet/Streaming/Nemotron/… and
//   Sources/FluidAudio/Diarizer/Sortformer/… in the FluidAudio 0.15.4 checkout.

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

/// Map a short `--lang` code to a full Nemotron locale. Full locales pass
/// through unchanged; `promptId(forLanguage:)` in FluidAudio normalizes casing.
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

/// Serializes NDJSON lines to stdout and records the running-hypothesis timeline.
///
/// The partial callback fires on the ASR actor's executor while the read loop runs
/// on the main task, so every mutation is guarded by a lock. `ts_ms` is derived
/// from `samplesFed` (audio-stream time) rather than wall clock so that the ASR
/// hypothesis timeline shares one clock with the Sortformer diarizer timeline.
final class Emitter: @unchecked Sendable {
    private struct Line: Encodable {
        let type: String
        let text: String
        let ts_ms: Int64
        let speaker: String?  // omitted from JSON when nil (synthesized encodeIfPresent)
    }

    /// A snapshot of the cumulative ASR hypothesis at a given audio-stream time.
    struct PartialSnapshot { let ms: Int64; let text: String }

    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private var lastPartial = ""
    private var samplesFed: Int64 = 0
    private var log_: [PartialSnapshot] = []

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

    /// Current audio-stream time in ms.
    func currentMs() -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return msLocked()
    }

    /// Running hypothesis. Consecutive duplicates are suppressed to cut noise.
    /// Each distinct hypothesis is timestamped and recorded for later attribution.
    func partial(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        guard t != lastPartial else { return }
        lastPartial = t
        let ms = msLocked()
        log_.append(PartialSnapshot(ms: ms, text: t))
        write(Line(type: "partial", text: t, ts_ms: ms, speaker: nil))
    }

    /// Committed segment. `speaker` is emitted only when non-nil.
    func final(_ text: String, tsMs: Int64, speaker: String? = nil) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        lastPartial = ""
        write(Line(type: "final", text: t, ts_ms: tsMs, speaker: speaker))
    }

    /// The recorded running-hypothesis timeline (cumulative snapshots, time-ordered).
    func partialLog() -> [PartialSnapshot] {
        lock.lock(); defer { lock.unlock() }
        return log_
    }
}

let emitter = Emitter()

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

// MARK: - Diarization → speaker turns

/// A merged run of consecutive same-speaker diarizer segments (a speaker "turn").
struct SpeakerTurn { let speakerIndex: Int; var startMs: Int64; var endMs: Int64 }

/// Merge time-ordered confirmed diarizer segments into coalesced speaker turns.
/// Adjacent segments assigned to the same speaker slot are joined; a different
/// speaker slot starts a new turn (so A,A,B → [A],[B]; A,B,A → [A],[B],[A]).
func mergeTurns(_ segments: [DiarizerSegment]) -> [SpeakerTurn] {
    let sorted = segments.sorted { $0.startFrame < $1.startFrame }
    var turns: [SpeakerTurn] = []
    for seg in sorted {
        let s = Int64(seg.startTime * 1000)
        let e = Int64(seg.endTime * 1000)
        if turns.count > 0, turns[turns.count - 1].speakerIndex == seg.speakerIndex {
            turns[turns.count - 1].endMs = max(turns[turns.count - 1].endMs, e)
        } else {
            turns.append(SpeakerTurn(speakerIndex: seg.speakerIndex, startMs: s, endMs: e))
        }
    }
    return turns
}

/// Cumulative ASR hypothesis text at (or just before) audio-stream time `ms`.
func cumulativeText(at ms: Int64, log: [Emitter.PartialSnapshot]) -> String {
    var t = ""
    for snap in log where snap.ms <= ms { t = snap.text }
    return t
}

/// Strip the `prefix` hypothesis off the front of the `whole` hypothesis, yielding
/// the words added between the two snapshots. Cache-aware RNNT partials are largely
/// append-only, so a prefix strip approximates "text spoken during this window".
func deltaText(_ whole: String, strippingPrefix prefix: String) -> String {
    let w = whole.trimmingCharacters(in: .whitespacesAndNewlines)
    let p = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
    if !p.isEmpty, w.hasPrefix(p) {
        return String(w.dropFirst(p.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return w
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
    log("ASR models loaded; effective chunk tier = \(effMs)ms (~\(effMs)ms partial latency)")
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
        let d = SortformerDiarizer(config: cfg, timelineConfig: .sortformerDefault)
        log("resolving Sortformer models (downloads diar-streaming-sortformer-coreml on first run)…")
        let models = try await SortformerModels.loadFromHuggingFace(config: cfg, computeUnits: .all)
        d.initialize(models: models)
        diarizer = d
        log("Sortformer models loaded (4 speaker slots, ~80ms frames)")
        // OPTIONAL ENROLLMENT ("Я" = the user's own voice): before the read loop,
        // load a reference WAV and prime the diarizer so the user's slot is known:
        //     let ref = try AudioConverter().resampleAudioFile("/path/enroll.wav")
        //     _ = try d.enrollSpeaker(withAudio: ref, named: "Я")
        // Then map that speaker's `index` to the label "Я" in `labelFor(...)`
        // instead of "Спикер N". Wire via a `--enroll <wav>` flag. Not required for
        // this task — generic "Спикер N" labels are the deliverable.
    } catch {
        log("Sortformer diarization unavailable (\(error)); continuing ASR-only")
        diarizer = nil
    }
}

// Running hypothesis → NDJSON partials (recorded for per-turn attribution).
await manager.setPartialCallback { text in
    emitter.partial(text)
}

// Incremental commit state. As each diarizer speaker segment finalizes mid-stream
// we emit one `final` immediately, slicing the running ASR hypothesis to the
// segment's window. `committedPrefix` is the hypothesis text already emitted (the
// commit cursor); each word is emitted exactly once.
var committedPrefix = ""
var emittedSegmentIds = Set<UUID>()
var labelForSlot: [Int: String] = [:]
var nextLabel = 1
var finalsEmitted = 0
var lastCommittedSlot: Int? = nil

/// Stable 1-based label for a Sortformer speaker slot, assigned on first sight.
@MainActor
func labelFor(_ slot: Int) -> String {
    if let l = labelForSlot[slot] { return l }
    let l = "Спикер \(nextLabel)"
    labelForSlot[slot] = l
    nextLabel += 1
    return l
}

/// Emit one `final` for a completed speaker segment. Its text is the slice of the
/// running hypothesis between the already-committed prefix and `endText` (the
/// cumulative hypothesis at the segment's end). Advances the commit cursor so the
/// same words are never re-emitted. No-op when the slice is empty.
@MainActor
func commitSegment(speakerIndex: Int, startMs: Int64, endText: String) {
    let delta = deltaText(endText, strippingPrefix: committedPrefix)
    guard !delta.isEmpty else { return }
    emitter.final(delta, tsMs: startMs, speaker: labelFor(speakerIndex))
    committedPrefix = endText
    lastCommittedSlot = speakerIndex
    finalsEmitted += 1
}

// Read live PCM in ~100 ms slices (3200 bytes = 1600 samples s16le) and feed
// immediately to BOTH engines. A stray trailing odd byte is carried to the next
// read so int16 samples never straddle a boundary.
let chunkBytes = 3200
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
            // closed (Sortformer holds a growing segment in per-speaker scratch and
            // only emits it here once it ends). Emit a labelled `final` right away.
            if let update = try d.process(samples: samples, sourceSampleRate: 16000) {
                let plog = emitter.partialLog()
                for seg in update.finalizedSegments.sorted(by: { $0.startFrame < $1.startFrame }) {
                    guard emittedSegmentIds.insert(seg.id).inserted else { continue }
                    commitSegment(
                        speakerIndex: seg.speakerIndex,
                        startMs: Int64(seg.startTime * 1000),
                        endText: cumulativeText(at: Int64(seg.endTime * 1000), log: plog))
                }
            }
        } catch {
            log("diarization processing error: \(error)")
        }
    }
}

// EOF → flush the ASR tail (single committed transcript) and finalize diarization.
let finalText: String
do {
    finalText = try await manager.finish()
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

// EOF flush: the last speaker turn(s) may still be tentative (never closed by a
// following speaker). finalizeSession() promotes them into the timeline; emit any
// segment not already committed mid-stream (deduped by id — see the documented
// finalizeSession bug: its returned update omits these promoted segments).
if let d = diarizer {
    do {
        _ = try d.finalizeSession()
    } catch {
        log("diarization finalize error: \(error)")
    }
    let tail = d.timeline.speakers.values
        .flatMap { $0.finalizedSegments }
        .filter { !emittedSegmentIds.contains($0.id) }
    let tailTurns = mergeTurns(tail)
    let plog = emitter.partialLog()
    for (i, turn) in tailTurns.enumerated() {
        // Fuller EOF transcript as the end text of the very last turn.
        let endText = (i == tailTurns.count - 1) ? trimmedFinal
            : cumulativeText(at: turn.endMs, log: plog)
        commitSegment(speakerIndex: turn.speakerIndex, startMs: turn.startMs, endText: endText)
    }
}

// Whatever hypothesis remains uncommitted after all speaker segments: trailing
// words after the last turn go to the most recent speaker; if diarization found
// nothing at all, emit one unlabelled final (old behaviour).
let remainder = deltaText(trimmedFinal, strippingPrefix: committedPrefix)
if !remainder.isEmpty {
    if let slot = lastCommittedSlot {
        emitter.final(remainder, tsMs: emitter.currentMs(), speaker: labelFor(slot))
    } else {
        emitter.final(remainder, tsMs: emitter.currentMs(), speaker: nil)
    }
    committedPrefix = trimmedFinal
    finalsEmitted += 1
}

log("EOF — \(finalsEmitted) final(s) total, \(labelForSlot.count) distinct speaker(s)")
exit(0)
