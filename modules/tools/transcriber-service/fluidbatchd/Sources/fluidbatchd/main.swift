import Foundation
import FluidAudio

// MARK: - Async grow-able work queue

actor WorkQueue {
    private var items: [(path: String, lang: Language?)] = []
    private var closed = false
    private var waiters: [CheckedContinuation<(String, Language?)?, Never>] = []

    func enqueue(path: String, lang: Language?) {
        if !waiters.isEmpty {
            let cont = waiters.removeFirst()
            cont.resume(returning: (path, lang))
            return
        }
        items.append((path, lang))
    }

    func close() {
        closed = true
        while !waiters.isEmpty {
            let cont = waiters.removeFirst()
            cont.resume(returning: nil)
        }
    }

    func dequeue() async -> (String, Language?)? {
        if !items.isEmpty {
            return items.removeFirst()
        }
        if closed { return nil }
        return await withCheckedContinuation { cont in
            waiters.append(cont)
        }
    }
}

// MARK: - JSON output shape

struct WordTimingOut: Codable {
    let word: String
    let startTime: TimeInterval
    let endTime: TimeInterval
    let confidence: Float
}

struct TranscriptionJSONOutput: Codable {
    let audioFile: String
    let mode: String
    let modelVersion: String
    let text: String
    let durationSeconds: TimeInterval?
    let processingTimeSeconds: TimeInterval?
    let rtfx: Float?
    let confidence: Float?
    let wordTimings: [WordTimingOut]
}

func mergeTokensIntoWords(_ tokens: [TokenTiming]) -> [WordTimingOut] {
    guard !tokens.isEmpty else { return [] }
    var words: [WordTimingOut] = []
    var cur = ""
    var start: TimeInterval? = nil
    var end: TimeInterval = 0
    var confs: [Float] = []

    func flush() {
        if !cur.isEmpty, let s = start {
            let avg = confs.isEmpty ? 0 : confs.reduce(0, +) / Float(confs.count)
            words.append(WordTimingOut(word: cur, startTime: s, endTime: end, confidence: avg))
        }
    }

    for t in tokens {
        let tok = t.token
        if tok.hasPrefix(" ") || tok.hasPrefix("\n") || tok.hasPrefix("\t") {
            flush()
            cur = tok.trimmingCharacters(in: .whitespacesAndNewlines)
            start = t.startTime
            end = t.endTime
            confs = [t.confidence]
        } else {
            if start == nil { start = t.startTime }
            cur += tok
            end = t.endTime
            confs.append(t.confidence)
        }
    }
    flush()
    return words
}

// MARK: - ffmpeg pre-conversion

func locateFfmpeg() -> String? {
    for c in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"] {
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return nil
}

let ffmpegPath: String? = locateFfmpeg()

func resampleTo16kMonoWav(input: URL) throws -> URL {
    guard let ffmpeg = ffmpegPath else {
        throw NSError(domain: "fluidbatchd", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "ffmpeg not found in /opt/homebrew/bin, /usr/local/bin, or /usr/bin"
        ])
    }
    let temp = FileManager.default.temporaryDirectory
        .appendingPathComponent("fluidbatchd_\(UUID().uuidString).wav")
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: ffmpeg)
    proc.arguments = [
        "-y", "-loglevel", "error", "-nostdin",
        "-i", input.path,
        "-map", "0:a",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        temp.path,
    ]
    proc.standardOutput = FileHandle.nullDevice
    let errPipe = Pipe()
    proc.standardError = errPipe
    try proc.run()
    proc.waitUntilExit()
    if proc.terminationStatus != 0 {
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        let errStr = String(data: errData, encoding: .utf8) ?? "unknown"
        try? FileManager.default.removeItem(at: temp)
        throw NSError(domain: "fluidbatchd", code: Int(proc.terminationStatus), userInfo: [
            NSLocalizedDescriptionKey: "ffmpeg failed: \(errStr.trimmingCharacters(in: .whitespacesAndNewlines))"
        ])
    }
    return temp
}

// MARK: - Per-file processing

struct ProcessingResult {
    let proc: TimeInterval
    let duration: TimeInterval
    let confidence: Float
    let rtfx: Float
}

func processOne(
    path: String,
    manager: AsrManager,
    language: Language?,
    outputDir: String
) async throws -> ProcessingResult {
    let url = URL(fileURLWithPath: path)
    let wavURL = try resampleTo16kMonoWav(input: url)
    defer { try? FileManager.default.removeItem(at: wavURL) }

    var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
    let t0 = Date()
    let result = try await manager.transcribe(wavURL, decoderState: &decoderState, language: language)
    let proc = Date().timeIntervalSince(t0)

    let words = mergeTokensIntoWords(result.tokenTimings ?? [])
    let duration: TimeInterval = result.duration > 0
        ? result.duration
        : (words.last?.endTime ?? 0)
    let rtfx: Float = duration > 0 ? Float(duration / proc) : 0

    let output = TranscriptionJSONOutput(
        audioFile: path,
        mode: "batch",
        modelVersion: "v3",
        text: result.text,
        durationSeconds: duration,
        processingTimeSeconds: proc,
        rtfx: rtfx,
        confidence: result.confidence,
        wordTimings: words
    )

    try FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
    let base = url.deletingPathExtension().lastPathComponent
    let outPath = "\(outputDir)/\(base).json"

    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try enc.encode(output)
    try data.write(to: URL(fileURLWithPath: outPath))

    return ProcessingResult(
        proc: proc,
        duration: duration,
        confidence: result.confidence,
        rtfx: rtfx
    )
}

// MARK: - Logging

func emitLine(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func tsvEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\t", with: "\\t")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: "\r", with: "")
}

func logReady(workers: Int) {
    emitLine("READY\tworkers=\(workers)")
}

func logStart(jobId: String, worker: Int) {
    emitLine("START\tjob_id=\(jobId)\tworker=\(worker)")
}

func logOk(jobId: String, worker: Int, r: ProcessingResult) {
    emitLine(String(
        format: "OK\tjob_id=%@\tworker=%d\tproc=%.3f\tdur=%.3f\tconf=%.4f\trtfx=%.2f",
        jobId, worker, r.proc, r.duration, r.confidence, r.rtfx
    ))
}

func logFail(jobId: String, worker: Int, error: String) {
    emitLine("FAIL\tjob_id=\(jobId)\tworker=\(worker)\terror=\(tsvEscape(error))")
}

// MARK: - Main

@main
struct FluidBatchd {
    static func main() async throws {
        var workers = 2
        var defaultLanguageCode: String? = "ru"
        var outputDir = FileManager.default.currentDirectoryPath + "/transcripts"

        let argv = Array(CommandLine.arguments.dropFirst())
        var i = 0
        while i < argv.count {
            switch argv[i] {
            case "--workers":
                i += 1
                if i < argv.count, let n = Int(argv[i]) { workers = max(1, n) }
            case "--language":
                i += 1
                if i < argv.count { defaultLanguageCode = argv[i] }
            case "--output-dir":
                i += 1
                if i < argv.count { outputDir = argv[i] }
            case "--help", "-h":
                print("""
                fluidbatchd — long-running parakeet-tdt-0.6b-v3 (CoreML/ANE) transcriber daemon.

                Reads stdin lines:  "<path>"   or   "<path>\\t<lang>"
                Writes JSON to:     <output-dir>/<basename>.json
                Emits stderr:       "READY\\tworkers=N"
                                    "OK\\tjob_id=…\\tworker=…\\tproc=…\\tdur=…\\tconf=…\\trtfx=…"
                                    "FAIL\\tjob_id=…\\tworker=…\\terror=…"

                Options:
                  --workers N        concurrent transcribe tasks (default 2)
                  --language CODE    default language (default 'ru'; '' = auto-detect)
                  --output-dir DIR   where to write JSON results (default ./transcripts)
                """)
                return
            default:
                emitLine("FAIL\tjob_id=-\tworker=-\terror=Unknown arg: \(argv[i])")
                return
            }
            i += 1
        }

        let defaultLanguage: Language?
        if let c = defaultLanguageCode, !c.isEmpty {
            guard let l = Language(rawValue: c.lowercased()) else {
                emitLine("FAIL\tjob_id=-\tworker=-\terror=Unknown language: \(c)")
                return
            }
            defaultLanguage = l
        } else {
            defaultLanguage = nil
        }

        // Load shared models once.
        let models = try await AsrModels.downloadAndLoad(version: .v3)

        // Build N AsrManagers sharing the same loaded models.
        var managers: [AsrManager] = []
        for _ in 0..<workers {
            let tdtConfig = TdtConfig(blankId: AsrModelVersion.v3.blankId)
            let asrConfig = ASRConfig(
                tdtConfig: tdtConfig,
                encoderHiddenSize: AsrModelVersion.v3.encoderHiddenSize
            )
            let m = AsrManager(config: asrConfig)
            try await m.loadModels(models)
            managers.append(m)
        }

        logReady(workers: workers)

        let queue = WorkQueue()
        let outDir = outputDir

        // Reader: detached task that pumps stdin lines into the queue.
        Task.detached {
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                let parts = trimmed.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
                let path = String(parts[0])
                var lang: Language? = defaultLanguage
                if parts.count == 2 {
                    let code = String(parts[1]).lowercased()
                    if !code.isEmpty {
                        if let parsed = Language(rawValue: code) {
                            lang = parsed
                        }
                    } else {
                        lang = nil
                    }
                }
                await queue.enqueue(path: path, lang: lang)
            }
            await queue.close()
        }

        // Workers consume from the shared queue.
        await withTaskGroup(of: Void.self) { group in
            for w in 0..<workers {
                let manager = managers[w]
                group.addTask { [outDir] in
                    while let item = await queue.dequeue() {
                        let url = URL(fileURLWithPath: item.0)
                        let jobId = url.deletingPathExtension().lastPathComponent
                        logStart(jobId: jobId, worker: w)
                        do {
                            let r = try await processOne(
                                path: item.0,
                                manager: manager,
                                language: item.1,
                                outputDir: outDir
                            )
                            logOk(jobId: jobId, worker: w, r: r)
                        } catch {
                            logFail(jobId: jobId, worker: w, error: "\(error)")
                        }
                    }
                }
            }
            await group.waitForAll()
        }
    }
}
