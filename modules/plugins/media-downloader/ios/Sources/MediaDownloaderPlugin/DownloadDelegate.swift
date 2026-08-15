import Foundation
import Capacitor

/**
 * URLSession delegate for the background downloader.
 *
 * Translates URLSession callbacks into plugin events. Threaded through
 * the plugin via `MediaDownloaderPlugin.emit(event:data:)` so all event
 * dispatch flows through one place.
 *
 * `taskIdentifier ↔ id` mapping is held in-memory; on relaunch
 * `MediaDownloaderPlugin.load()` rebinds via `bind()` based on URL.
 */
final class DownloadDelegate: NSObject, URLSessionDelegate, URLSessionDownloadDelegate {

    private weak var plugin: MediaDownloaderPlugin?
    private let metadataStore: TaskMetadataStore
    /**
     * Reached from two serial queues — URLSession's delegate queue (the
     * callbacks below) and Capacitor's bridge queue (`bind` from
     * `startNewDownload`, `unbind`/`id(for:)` from the session's task-list
     * callbacks) — and unsynchronized mutation of a Swift Dictionary is
     * undefined behaviour, not merely a lost write (#1836). Every touch goes
     * through the accessors, which hold the lock.
     */
    private var idByTaskIdentifier: [Int: String] = [:]
    private let mapLock = NSLock()

    init(plugin: MediaDownloaderPlugin, metadataStore: TaskMetadataStore) {
        self.plugin = plugin
        self.metadataStore = metadataStore
    }

    func bind(taskIdentifier: Int, id: String) {
        mapLock.lock()
        defer { mapLock.unlock() }
        idByTaskIdentifier[taskIdentifier] = id
    }

    func id(for taskIdentifier: Int) -> String? {
        mapLock.lock()
        defer { mapLock.unlock() }
        return idByTaskIdentifier[taskIdentifier]
    }

    /**
     * Stop a task from speaking for its id. Used when `download()` replaces
     * a stale task under the same id — an unbound task's events are dropped
     * by the guards below, so the replacement can't be settled by its
     * predecessor's cancellation.
     */
    func unbind(taskIdentifier: Int) {
        mapLock.lock()
        defer { mapLock.unlock() }
        idByTaskIdentifier.removeValue(forKey: taskIdentifier)
    }

    /// Read the binding and drop it in one step, so a task can settle its id
    /// exactly once even if the terminal callback arrives twice.
    private func unbindReturningId(taskIdentifier: Int) -> String? {
        mapLock.lock()
        defer { mapLock.unlock() }
        return idByTaskIdentifier.removeValue(forKey: taskIdentifier)
    }

    /// Which HTTP statuses may become a saved file. Same window as OkHttp's
    /// `isSuccessful` on the Android side; redirects never reach here, since
    /// URLSession follows them and reports the final response.
    static func isSuccessful(statusCode: Int) -> Bool {
        (200...299).contains(statusCode)
    }

    // ── URLSessionDownloadDelegate ────────────────────────────────────────

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let id = id(for: downloadTask.taskIdentifier) else { return }
        var data: [String: Any] = [
            "id": id,
            "bytesDownloaded": totalBytesWritten,
            "contentLength": max(0, totalBytesExpectedToWrite),
        ]
        if totalBytesExpectedToWrite > 0 {
            data["progress"] = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        }
        plugin?.emit(event: "progress", data: data)
        // Deliberately no store write: this fires many times a second per task,
        // and persisting the counts here is what made every chunk a
        // read-modify-write of the whole store (#1836). The live numbers are in
        // the event above, which is where the app reads them; the store gets
        // the final counts once, when the transfer ends.
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let id = id(for: downloadTask.taskIdentifier),
              let entry = metadataStore.get(id: id) else { return }

        // URLSession delivers this callback for ANY completed response, 4xx and
        // 5xx included, where the temp file holds the CDN's error document and
        // not the lecture. Same rejection as Android's `HTTP <code>`, so the JS
        // layer reads one vocabulary and fails the attempt over to a sibling.
        if let http = downloadTask.response as? HTTPURLResponse,
           !Self.isSuccessful(statusCode: http.statusCode) {
            // Only the entry goes. Nothing of ours is at the destination — we
            // never moved anything there — and a sibling CDN candidate writes to
            // that same path, so deleting it could take away its finished file.
            metadataStore.remove(id: id)
            plugin?.emit(event: "failed", data: [
                "id": id,
                "error": "HTTP \(http.statusCode)",
            ])
            return
        }

        // Re-anchor as every other consumer of a stored path does: a background
        // download can also COMPLETE after an app update, and the move into a
        // dead container's path fails — discarding bytes already fetched in
        // full. Mirrors the failure branch below.
        let path = plugin?.resolvedPath(entry.localPath) ?? entry.localPath
        let destinationUrl = URL(fileURLWithPath: path)
        do {
            let parent = destinationUrl.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destinationUrl.path) {
                try FileManager.default.removeItem(at: destinationUrl)
            }
            try FileManager.default.moveItem(at: location, to: destinationUrl)
        } catch {
            // The download succeeded over the wire but we couldn't put
            // it at its final path. Drop the bookkeeping so the next
            // resolveLocalUrl can't hand back a phantom URL for this
            // trackId, and so the next download attempt starts clean.
            try? FileManager.default.removeItem(atPath: destinationUrl.path)
            metadataStore.remove(id: id)
            plugin?.emit(event: "failed", data: [
                "id": id,
                "error": "Failed to move downloaded file: \(error.localizedDescription)",
            ])
            return
        }

        // The entry stays — it is what maps a file key back to the saved file
        // for `resolveLocalUrl` and `deleteFile`, so pruning on success would
        // orphan the lecture — but it is no longer a task, and marking it is
        // what lets start-up tell a dead index from a live download. The counts
        // are written here, once, instead of on every chunk; the task carries
        // the totals, so nothing is lost by not having tracked them.
        var finished = entry
        finished.bytesDownloaded = max(entry.bytesDownloaded, downloadTask.countOfBytesReceived)
        finished.contentLength = max(
            finished.bytesDownloaded,
            max(0, downloadTask.countOfBytesExpectedToReceive)
        )
        finished.completed = true
        metadataStore.put(finished)

        plugin?.emit(event: "completed", data: [
            "id": id,
            "localUrl": "file://" + destinationUrl.path,
            "bytesDownloaded": finished.bytesDownloaded,
        ])
        plugin?.emit(event: "stateChanged", data: [
            "task": [
                "id": id,
                "state": "completed",
                "bytesDownloaded": finished.bytesDownloaded,
                "contentLength": finished.contentLength,
                "progress": 1,
                "localUrl": "file://" + destinationUrl.path,
            ]
        ])
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = unbindReturningId(taskIdentifier: task.taskIdentifier) else { return }
        guard let error = error else { return } // success path handled in didFinishDownloadingTo
        let nsError = error as NSError
        let isCancelled = nsError.code == NSURLErrorCancelled
        if isCancelled {
            plugin?.emit(event: "stateChanged", data: [
                "task": [
                    "id": id,
                    "state": "cancelled",
                    "bytesDownloaded": 0,
                    "contentLength": 0,
                ]
            ])
            // A cancellation is terminal for the JS caller too: its promise
            // resolves on `completed` and rejects on `failed`, so without a
            // terminal event it stays pending forever and never releases the
            // download slot. The `cancelled` code tells a deliberate abort
            // apart from a genuine failure, so the UI can skip the retry
            // affordance.
            plugin?.emit(event: "failed", data: [
                "id": id,
                "error": "cancelled",
                "code": "cancelled",
            ])
            return
        }
        // Clean up the metadata entry AND any partial file URLSession
        // may have written before failing. Without this, the next call
        // to `resolveLocalUrl(url)` would still find both the entry and
        // `fileExists` returning true (for the stale partial), and the
        // TS store would mark the track as completed without a real
        // download ever happening. The Android side gets this for free
        // via its `.download` temp-file + atomic-rename pattern.
        if let entry = metadataStore.get(id: id) {
            // Re-anchor the stored path to the live container before deleting:
            // a background download can fail after an app update, when the
            // UUID baked into entry.localPath is stale and the raw path would
            // miss the partial (leaving it orphaned). Mirrors the cancel path.
            let path = plugin?.resolvedPath(entry.localPath) ?? entry.localPath
            try? FileManager.default.removeItem(atPath: path)
        }
        metadataStore.remove(id: id)
        plugin?.emit(event: "failed", data: [
            "id": id,
            "error": error.localizedDescription,
        ])
    }

}
