import Foundation

/// One recorded queue transition. Mirrors the `QueueTransition` TS type
/// in `src/definitions.ts` exactly — positions/durations in **seconds**,
/// `at` in epoch milliseconds, `seq` a monotonic per-install counter.
///
/// Only `reason == "auto"` (a natural `AVPlayerItemDidPlayToEndTime`)
/// marks the finished item as completed; skips/errors finish it at
/// `finishedAt < duration`.
struct QueueTransition: Codable {
    let finishedItemId: String
    let fromPosition: Double
    let finishedAt: Double
    let duration: Double
    let startedItemId: String?
    let reason: String   // "auto" | "skip-next" | "skip-prev" | "error"
    let at: Double       // epoch ms
    let seq: Int

    /// Capacitor JSObject-friendly dictionary. `startedItemId` is encoded
    /// as `NSNull` when nil so the JS side sees an explicit `null`.
    func toDictionary() -> [String: Any] {
        return [
            "finishedItemId": finishedItemId,
            "fromPosition": fromPosition,
            "finishedAt": finishedAt,
            "duration": duration,
            "startedItemId": startedItemId ?? NSNull(),
            "reason": reason,
            "at": at,
            "seq": seq
        ]
    }
}

/// The whole durable on-disk state: the transition journal plus the
/// last persisted in-flight position. Written to a JSON file in
/// Application Support so it survives the app being killed in the
/// background before JS ever wakes to drain it.
private struct JournalFile: Codable {
    var transitions: [QueueTransition]
    var lastSeq: Int
    var currentItemId: String?
    var positionSec: Double
}

/// Durable, kill-survivable journal of queue transitions + in-flight
/// position. Backed by a single JSON file in Application Support.
///
/// Thread-safety: all access is serialised through `queue`. Writes are
/// synchronous (`queue.sync`) on the journal-append path so the entry is
/// on disk before the caller (e.g. the queue-ran-dry teardown) proceeds,
/// per the plan's "persist before teardown" rule (§3.4).
final class QueueJournal {

    private let queue = DispatchQueue(label: "com.lectorium.audioplayer.journal")
    private let fileURL: URL
    private var state: JournalFile

    init() {
        let fm = FileManager.default
        let baseDir = (try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fm.temporaryDirectory
        let dir = baseDir.appendingPathComponent("LectoriumAudioPlayer", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("queue-journal.json")

        // Load any persisted state from a previous process.
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(JournalFile.self, from: data) {
            state = decoded
        } else {
            state = JournalFile(transitions: [], lastSeq: 0, currentItemId: nil, positionSec: 0)
        }
    }

    /// Next monotonic sequence number. Persisted, so it keeps climbing
    /// across process restarts and never collides with un-acked events.
    func nextSeq() -> Int {
        return queue.sync {
            state.lastSeq += 1
            persistLocked()
            return state.lastSeq
        }
    }

    /// Append a transition durably. Synchronous: returns only once the
    /// JSON file has been (re)written, so callers can teardown safely.
    func append(_ transition: QueueTransition) {
        queue.sync {
            state.transitions.append(transition)
            if transition.seq > state.lastSeq {
                state.lastSeq = transition.seq
            }
            persistLocked()
        }
    }

    /// Persist the in-flight `{currentItemId, positionSec}` so a hard
    /// background kill loses at most the cadence interval of accuracy.
    func savePosition(itemId: String?, positionSec: Double) {
        queue.sync {
            state.currentItemId = itemId
            state.positionSec = positionSec
            persistLocked()
        }
    }

    /// All buffered transitions, in `seq` order. Reading does NOT clear —
    /// JS calls `ack(upToSeq:)` after it has persisted them.
    func allTransitions() -> [QueueTransition] {
        return queue.sync {
            return state.transitions.sorted { $0.seq < $1.seq }
        }
    }

    /// Last persisted in-flight position snapshot, for cold-start resync.
    func lastPosition() -> (itemId: String?, positionSec: Double) {
        return queue.sync {
            return (state.currentItemId, state.positionSec)
        }
    }

    /// Drop every transition with `seq <= upToSeq`. Idempotent.
    func ack(upToSeq: Int) {
        queue.sync {
            state.transitions.removeAll { $0.seq <= upToSeq }
            persistLocked()
        }
    }

    // Must be called on `queue`.
    private func persistLocked() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        // Atomic write so a crash mid-write can't leave a truncated file.
        try? data.write(to: fileURL, options: .atomic)
    }
}
