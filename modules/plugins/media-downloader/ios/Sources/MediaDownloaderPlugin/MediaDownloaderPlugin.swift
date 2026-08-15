import Foundation
// Explicit for `rmdir(2)`, which Foundation only re-exports.
import Darwin
import Capacitor

/**
 * Background-capable downloader on top of `URLSession` with a
 * `.background` configuration.
 *
 * iOS handles the background lifecycle for us — the OS may suspend the
 * app while the system daemon continues the transfer, and may relaunch
 * the app to deliver completion via
 * `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
 * The host app's AppDelegate is expected to forward that call into this
 * plugin (see DownloadDelegate's `completionHandler`).
 *
 * Path resolution: the JS adapter passes a `destination` whose `directory`
 * selects the base folder — `"data"` → `NSDocumentDirectory` (durable; the
 * user's saved-for-offline audio + transcripts) or `"cache"` →
 * `NSCachesDirectory` (OS-reclaimable; ephemeral share clips). The plugin
 * doesn't second-guess the subdir/filename derived from the URL pathname.
 */
@objc(MediaDownloaderPlugin)
public class MediaDownloaderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MediaDownloaderPlugin"
    public let jsName = "MediaDownloader"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTask", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listTasks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveLocalUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
    ]

    private static let backgroundIdentifier = "studio.jiva.shruti.mediadownloader"
    private static let metadataKey = "shruti.media-downloader.tasks"

    private lazy var delegate: DownloadDelegate = {
        DownloadDelegate(plugin: self, metadataStore: metadataStore)
    }()

    /// How long a request may go without delivering data before it fails.
    /// Matches the JS candidate loop's ceiling: it hedges CDN regions ~5 s
    /// apart and gives the whole connection phase ~15 s, so a task that has
    /// said nothing by then is one the loop has already given up on.
    private static let requestTimeout: TimeInterval = 15

    /// Ceiling for a whole transfer. Lecture audio runs to ~150 MB and a
    /// background session may legitimately be stretched over a slow link, so
    /// this is a backstop against a task that never ends, not a performance
    /// bound.
    private static let resourceTimeout: TimeInterval = 60 * 60

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.backgroundIdentifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        // Without these the session ran on URLSession's defaults and the
        // plugin set no ceiling of its own. A stalled transfer did still
        // surface — `URLRequest(url:)` carries a 60 s default and reports
        // `NSURLErrorTimedOut` through `didCompleteWithError` — but nothing
        // in our code chose that bound, and there was no watchdog behind it.
        // Now both platforms fail on the same policy.
        config.timeoutIntervalForRequest = Self.requestTimeout
        config.timeoutIntervalForResource = Self.resourceTimeout
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()

    private let metadataStore = TaskMetadataStore(suiteName: metadataKey)

    public override func load() {
        super.load()
        // Touch the lazy session so the delegate is wired up at start.
        // With `sessionSendsLaunchEvents = true`, iOS already buffers
        // completion events while the app was suspended and fires them
        // through the URLSessionDownloadDelegate when the app comes back.
        _ = session
        // A finished entry is nothing but an index into the file system, so
        // one whose file is gone — deleted outside the app, container reset —
        // indexes nothing and goes. Bounded on purpose: an unfinished entry
        // has no file yet by definition, and iOS may still be about to report
        // its transfer through the delegate on a launch-from-background, where
        // dropping the entry is exactly what loses the download.
        for entry in metadataStore.all() where entry.isCompleted {
            if !FileManager.default.fileExists(atPath: resolvedPath(entry.localPath)) {
                metadataStore.remove(id: entry.id)
            }
        }
        // After a launch-from-background, re-bind any in-flight tasks to
        // their stored metadata so events fire with the right id.
        session.getTasksWithCompletionHandler { _, _, downloadTasks in
            for task in downloadTasks {
                if let url = task.originalRequest?.url?.absoluteString,
                   let entry = self.metadataStore.findByUrl(url) {
                    self.delegate.bind(taskIdentifier: task.taskIdentifier, id: entry.id)
                }
            }
        }
    }

    // ── Plugin API ────────────────────────────────────────────────────────

    @objc func download(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("'id' is required") }
        guard let fileKey = call.getString("fileKey") else {
            return call.reject("'fileKey' is required")
        }
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            return call.reject("'url' is required and must be valid")
        }
        guard let destination = call.getObject("destination"),
              let localPath = resolveLocalPath(destination: destination) else {
            return call.reject("'destination' is required (must contain filename)")
        }

        // Idempotency: if we already have an active download for this id, reuse it.
        if let existing = metadataStore.get(id: id) {
            session.getAllTasks { tasks in
                if let active = tasks.first(where: { $0.originalRequest?.url?.absoluteString == existing.url
                    && $0.state == .running }) {
                    self.delegate.bind(taskIdentifier: active.taskIdentifier, id: id)
                    let task: [String: Any] = [
                        "id": id,
                        "state": "running",
                        "bytesDownloaded": existing.bytesDownloaded,
                        "contentLength": existing.contentLength,
                    ]
                    call.resolve(task)
                    return
                }
                // Nothing live for this id, so we are about to supersede it.
                // Any stale task still bound to this id must stop speaking
                // for it first: its cancellation/failure would be delivered
                // under an id the replacement now owns, and the JS caller —
                // which addresses events by id — would settle the download
                // we are starting. Unbinding also makes the cancel below
                // silent (the delegate guards on the binding).
                for task in tasks where self.delegate.id(for: task.taskIdentifier) == id {
                    self.delegate.unbind(taskIdentifier: task.taskIdentifier)
                    task.cancel()
                }
                self.startNewDownload(call: call, id: id, fileKey: fileKey, url: url, localPath: localPath)
            }
        } else {
            startNewDownload(call: call, id: id, fileKey: fileKey, url: url, localPath: localPath)
        }
    }

    private func startNewDownload(
        call: CAPPluginCall,
        id: String,
        fileKey: String,
        url: URL,
        localPath: String
    ) {
        var request = URLRequest(url: url)
        // Explicit rather than inheriting `URLRequest`'s 60 s default, which
        // outlives the JS candidate loop's whole ceiling.
        request.timeoutInterval = Self.requestTimeout
        if let headers = call.getObject("headers") as? [String: String] {
            for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        }
        let downloadTask = session.downloadTask(with: request)
        let entry = TaskMetadataStore.Entry(
            id: id,
            fileKey: fileKey,
            url: url.absoluteString,
            localPath: localPath,
            bytesDownloaded: 0,
            contentLength: 0
        )
        metadataStore.put(entry)
        delegate.bind(taskIdentifier: downloadTask.taskIdentifier, id: id)
        downloadTask.resume()

        let payload: [String: Any] = [
            "id": id,
            "state": "pending",
            "bytesDownloaded": 0,
            "contentLength": 0,
        ]
        call.resolve(payload)
    }

    @objc func pause(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("'id' is required") }
        session.getAllTasks { tasks in
            for task in tasks where self.delegate.id(for: task.taskIdentifier) == id {
                task.suspend()
            }
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("'id' is required") }
        session.getAllTasks { tasks in
            for task in tasks where self.delegate.id(for: task.taskIdentifier) == id {
                task.resume()
            }
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("'id' is required") }
        let deletePartial = call.getBool("deletePartial") ?? false
        session.getAllTasks { tasks in
            for task in tasks where self.delegate.id(for: task.taskIdentifier) == id {
                task.cancel()
            }
            if deletePartial, let entry = self.metadataStore.get(id: id) {
                try? FileManager.default.removeItem(atPath: self.resolvedPath(entry.localPath))
            }
            self.metadataStore.remove(id: id)
            call.resolve()
        }
    }

    @objc func getTask(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("'id' is required") }
        guard let entry = metadataStore.get(id: id) else {
            call.resolve(["task": NSNull()])
            return
        }
        let path = resolvedPath(entry.localPath)
        let exists = FileManager.default.fileExists(atPath: path)
        let state: String = exists ? "completed" : "running"
        var task: [String: Any] = [
            "id": id,
            "state": state,
            "bytesDownloaded": entry.bytesDownloaded,
            "contentLength": entry.contentLength,
        ]
        if exists { task["localUrl"] = "file://" + path }
        call.resolve(["task": task])
    }

    @objc func listTasks(_ call: CAPPluginCall) {
        var tasks: [[String: Any]] = []
        for entry in metadataStore.all() {
            let path = resolvedPath(entry.localPath)
            let exists = FileManager.default.fileExists(atPath: path)
            let state = exists ? "completed" : "running"
            var t: [String: Any] = [
                "id": entry.id,
                "state": state,
                "bytesDownloaded": entry.bytesDownloaded,
                "contentLength": entry.contentLength,
            ]
            if exists { t["localUrl"] = "file://" + path }
            tasks.append(t)
        }
        call.resolve(["tasks": tasks])
    }

    @objc func resolveLocalUrl(_ call: CAPPluginCall) {
        guard let fileKey = call.getString("fileKey") else {
            return call.reject("'fileKey' is required")
        }
        // The first entry that is actually on disk, not simply the first: the
        // key owns one entry per raced CDN candidate and they all name the
        // same destination, so a miss on one says nothing about the file.
        for entry in metadataStore.findAllByFileKey(fileKey) {
            let path = resolvedPath(entry.localPath)
            if FileManager.default.fileExists(atPath: path) {
                call.resolve(["localUrl": "file://" + path])
                return
            }
        }
        call.resolve(["localUrl": NSNull()])
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let fileKey = call.getString("fileKey") else {
            return call.reject("'fileKey' is required")
        }
        // Every entry for the key, not the first. A key owns as many entries as
        // the JS layer raced CDN candidates for it, all naming the one shared
        // destination, and leaving the siblings behind leaves `resolveLocalUrl`
        // answering for a lecture the user deleted. Android removes them all.
        var deletedPaths = Set<String>()
        for entry in metadataStore.findAllByFileKey(fileKey) {
            let path = resolvedPath(entry.localPath)
            if deletedPaths.insert(path).inserted {
                try? FileManager.default.removeItem(atPath: path)
                pruneEmptyParents(of: path)
            }
            metadataStore.remove(id: entry.id)
        }
        call.resolve()
    }

    // ── Internals ─────────────────────────────────────────────────────────

    /// Drop the directories the deleted file leaves behind (#160).
    ///
    /// A destination mirrors the URL path, so every track owns a chain of
    /// directories that nothing else writes to; removing the file emptied
    /// them but left them on disk.
    ///
    /// `rmdir(2)`, never `removeItem` — the latter is recursive, and asking
    /// `contentsOfDirectory` first would leave a window between "looks empty"
    /// and the removal. `rmdir` refuses anything but an empty directory in one
    /// step, so a file that arrives meanwhile is never taken with it.
    ///
    /// A background transfer for a sibling CDN candidate keeps its bytes in
    /// the session's own temp file and only moves them here on completion, so
    /// unlike Android there is nothing in the directory to protect it — it
    /// doesn't need protecting: `DownloadDelegate` creates the parent chain
    /// with intermediates right before the move.
    ///
    /// Walks up while each level came away, and never past Documents /
    /// Caches — the bases themselves stay.
    private func pruneEmptyParents(of path: String) {
        let bases = [FileManager.SearchPathDirectory.documentDirectory, .cachesDirectory]
            .compactMap { FileManager.default.urls(for: $0, in: .userDomainMask).first?.path }
        var dir = (path as NSString).deletingLastPathComponent
        while bases.contains(where: { dir.hasPrefix($0 + "/") }) {
            if rmdir(dir) != 0 { return }
            dir = (dir as NSString).deletingLastPathComponent
        }
    }

    private func resolveLocalPath(destination: JSObject) -> String? {
        guard let filename = destination["filename"] as? String, !filename.isEmpty else {
            return nil
        }
        let directory = (destination["directory"] as? String) ?? "cache"
        let subdir = destination["subdir"] as? String

        let searchPath: FileManager.SearchPathDirectory =
            directory == "data" ? .documentDirectory : .cachesDirectory
        guard let baseUrl = FileManager.default.urls(for: searchPath, in: .userDomainMask).first else {
            return nil
        }
        var dirUrl = baseUrl
        if let subdir = subdir, !subdir.isEmpty {
            dirUrl = baseUrl.appendingPathComponent(subdir, isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dirUrl, withIntermediateDirectories: true)
        return dirUrl.appendingPathComponent(filename).path
    }

    /// Re-anchor a stored absolute path to the *current* app container.
    ///
    /// iOS assigns a new container UUID on every install/update, so an
    /// absolute path persisted by a previous version
    /// (`…/<old-UUID>/Library/Caches/shruti/file.mp3`) no longer
    /// resolves after an update — which is why offline downloads appeared
    /// to vanish. The trailing components (after the Caches/Documents
    /// base) are stable, so we keep that tail and re-join it with the live
    /// base dir. A path already under the current container is returned
    /// unchanged; an unrecognised path is returned as-is.
    ///
    /// Internal (not private) so `DownloadDelegate` can re-anchor a stored
    /// path before deleting a partial file on failure — a background download
    /// can fail after an app update, when the stored container UUID is stale.
    func resolvedPath(_ stored: String) -> String {
        let anchors: [(marker: String, dir: FileManager.SearchPathDirectory)] = [
            ("/Library/Caches/", .cachesDirectory),
            ("/Documents/", .documentDirectory),
        ]
        for (_, dir) in anchors {
            if let base = FileManager.default.urls(for: dir, in: .userDomainMask).first,
               stored.hasPrefix(base.path) {
                return stored
            }
        }
        for (marker, dir) in anchors {
            if let range = stored.range(of: marker, options: .backwards),
               let base = FileManager.default.urls(for: dir, in: .userDomainMask).first {
                return base.appendingPathComponent(String(stored[range.upperBound...])).path
            }
        }
        return stored
    }

    // ── Bridge helpers used by the delegate ───────────────────────────────

    func emit(event: String, data: [String: Any]) {
        notifyListeners(event, data: data)
    }
}
