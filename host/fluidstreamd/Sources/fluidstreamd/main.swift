// fluidstreamd — real-time streaming ASR daemon (one process per audio channel).
//
// CONTRACT (frozen — see repo README §protocol):
//   stdin  : raw PCM, signed 16-bit little-endian, mono, 16 kHz — a LIVE stream,
//            written by the client as audio is spoken (NOT a pre-recorded file
//            handed over at the end). Read in small chunks and fed immediately.
//   stdout : NDJSON, one object per line, flushed as soon as it is produced:
//              {"type":"partial","text":"...","ts_ms":1234}   ← running hypothesis, streams continuously
//              {"type":"final","text":"...","ts_ms":5678}     ← committed segment at end-of-stream (EOF)
//   stderr : human logs only.
//   EOF on stdin → flush the tail via finish(), emit a last "final", exit 0.
//
// ENGINE: FluidAudio `StreamingNemotronMultilingualAsrManager` — the CoreML build
// of NVIDIA Nemotron 3.5 ASR Streaming Multilingual 0.6B (FastConformer-RNNT,
// cache-aware TRUE streaming on the Apple Neural Engine). We always load the
// full-vocab `multilingual/` variant (NOT `latin/`, which prunes Cyrillic and
// cannot do Russian). Both Russian (ru-RU) and English (en-US) are in the
// model's "transcription-ready" top tier. Language is selected per-process via
// `--lang` → the encoder `prompt_id`. Chunk/latency tier: 2240 ms (2 s), the
// vendor-recommended default at which the 13087-token joint fits the ANE
// working set efficiently.
//
// NOTE ON FINALS: unlike the Parakeet-EOU model, Nemotron has no end-of-utterance
// token, so there is no automatic mid-stream segmentation. Partials stream
// continuously and a single committed `final` is emitted at EOF (per the frozen
// contract). Periodic/utterance-level finalization would need an external VAD or
// a `finalize` control signal — out of scope here; see report.
//
// Reference: Sources/FluidAudio/ASR/Parakeet/Streaming/Nemotron/
//   StreamingNemotronMultilingualAsrManager*.swift and the
//   NemotronMultilingualTranscribe CLI command in the FluidAudio checkout.

import FluidAudio
import Foundation

// MARK: - CLI

var lang = "ru"       // language hint; mapped to a Nemotron locale below
var chunkMs = 2240    // latency tier (ms): 560 / 1120 / 2240 (default) / 4480
do {
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--lang":
            if i + 1 < args.count { lang = args[i + 1]; i += 1 }
        case "--chunk-ms":
            if i + 1 < args.count { chunkMs = Int(args[i + 1]) ?? chunkMs; i += 1 }
        case "--help", "-h":
            FileHandle.standardError.write(Data("usage: fluidstreamd [--lang <code>] [--chunk-ms 560|1120|2240|4480]\n".utf8))
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
        // Already a locale like "de-DE" / "ru-RU": pass through. A bare unknown
        // code is handed to the model as-is (it falls back to auto if unknown).
        return code.contains("-") ? code : c
    }
}

// MARK: - NDJSON emitter (thread-safe, unbuffered, ordered)

/// Serializes NDJSON lines to stdout. The partial callback fires on the ASR
/// actor's executor while the read loop runs on the main task, so every write is
/// guarded by a lock and flushed immediately (FileHandle.write is unbuffered).
final class Emitter: @unchecked Sendable {
    private struct Line: Encodable {
        let type: String
        let text: String
        let ts_ms: Int64
    }

    private let lock = NSLock()
    private let start = DispatchTime.now().uptimeNanoseconds
    private let encoder = JSONEncoder()
    private var lastPartial = ""

    private func tsMs() -> Int64 {
        Int64((DispatchTime.now().uptimeNanoseconds &- start) / 1_000_000)
    }

    private func write(_ line: Line) {
        guard var data = try? encoder.encode(line) else { return }
        data.append(0x0A)  // '\n'
        FileHandle.standardOutput.write(data)
    }

    /// Running hypothesis. Consecutive duplicates are suppressed to cut noise.
    func partial(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        guard t != lastPartial else { return }
        lastPartial = t
        write(Line(type: "partial", text: t, ts_ms: tsMs()))
    }

    /// Committed segment (emitted at EOF).
    func final(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        lastPartial = ""
        write(Line(type: "final", text: t, ts_ms: tsMs()))
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

// MARK: - Main

let locale = nemotronLocale(lang)
log("starting (lang=\(lang) → locale=\(locale), engine=Nemotron 3.5 Multilingual 0.6B @\(chunkMs)ms, ANE)")

let manager = StreamingNemotronMultilingualAsrManager()

do {
    // Always fetch the full-vocab `multilingual/<chunkMs>ms` variant (routing
    // token "multilingual" forces the multilingual folder even for en-US, which
    // languageDirectory(for:) would otherwise route to the Cyrillic-less latin
    // model). First run downloads to ~/Library/Application Support/FluidAudio.
    log("resolving models (downloads multilingual/\(chunkMs)ms on first run)…")
    let variantDir = try await StreamingNemotronMultilingualAsrManager.downloadVariant(
        languageCode: "multilingual", chunkMs: chunkMs)
    try await manager.loadModels(from: variantDir)
    await manager.setLanguage(locale)
    let effMs = await manager.config.chunkMs
    log("models loaded; effective chunk tier = \(effMs)ms (~\(effMs)ms partial latency)")
} catch {
    log("failed to load models: \(error)")
    exit(1)
}

// Running hypothesis → NDJSON partials.
await manager.setPartialCallback { text in
    emitter.partial(text)
}

// Read live PCM in ~100 ms slices (3200 bytes = 1600 samples s16le) and feed
// immediately. `process(samples:)` buffers internally and drains complete
// (2 s) chunks, firing the partial callback as new tokens are decoded. A stray
// trailing odd byte is carried to the next read so int16 samples never straddle
// a boundary.
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
    do {
        _ = try await manager.process(samples: samples)
    } catch {
        log("processing error: \(error)")
    }
}

// EOF → flush the tail (pads + processes the final partial chunk) and commit.
do {
    let tail = try await manager.finish()
    emitter.final(tail)
    if let detected = await manager.detectedLanguage() {
        log("EOF — finished (model-detected language tag: \(detected))")
    } else {
        log("EOF — finished")
    }
} catch {
    log("finish error: \(error)")
    exit(1)
}

exit(0)
