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
    private var idByTaskIdentifier: [Int: String] = [:]

    init(plugin: MediaDownloaderPlugin, metadataStore: TaskMetadataStore) {
        self.plugin = plugin
        self.metadataStore = metadataStore
    }

    func bind(taskIdentifier: Int, id: String) {
        idByTaskIdentifier[taskIdentifier] = id
    }

    func id(for taskIdentifier: Int) -> String? {
        idByTaskIdentifier[taskIdentifier]
    }

    // ── URLSessionDownloadDelegate ────────────────────────────────────────

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let id = idByTaskIdentifier[downloadTask.taskIdentifier] else { return }
        var data: [String: Any] = [
            "id": id,
            "bytesDownloaded": totalBytesWritten,
            "contentLength": max(0, totalBytesExpectedToWrite),
        ]
        if totalBytesExpectedToWrite > 0 {
            data["progress"] = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        }
        plugin?.emit(event: "progress", data: data)

        if var entry = metadataStore.get(id: id) {
            entry.bytesDownloaded = totalBytesWritten
            entry.contentLength = max(0, totalBytesExpectedToWrite)
            metadataStore.put(entry)
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let id = idByTaskIdentifier[downloadTask.taskIdentifier],
              let entry = metadataStore.get(id: id) else { return }

        let destinationUrl = URL(fileURLWithPath: entry.localPath)
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
                "retryable": false,
            ])
            return
        }

        plugin?.emit(event: "completed", data: [
            "id": id,
            "localUrl": "file://" + destinationUrl.path,
            "bytesDownloaded": entry.bytesDownloaded,
        ])
        plugin?.emit(event: "stateChanged", data: [
            "task": [
                "id": id,
                "state": "completed",
                "bytesDownloaded": entry.bytesDownloaded,
                "contentLength": max(entry.contentLength, entry.bytesDownloaded),
                "progress": 1,
                "localUrl": "file://" + destinationUrl.path,
            ]
        ])
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = idByTaskIdentifier[task.taskIdentifier] else { return }
        idByTaskIdentifier.removeValue(forKey: task.taskIdentifier)
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
            return
        }
        let retryable = [NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost,
                         NSURLErrorNotConnectedToInternet].contains(nsError.code)
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
            "retryable": retryable,
        ])
    }

}
