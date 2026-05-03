import Foundation
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
 * Path resolution: the JS adapter passes a fully-resolved on-disk path
 * via `destination` so the result lands in the same directory as
 * `useCapacitorRemoteFilesStorage` reads from (NSCachesDirectory +
 * "lectorium/" + URL.pathname). The plugin doesn't second-guess the path.
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
    private static let metadataKey = "lectorium.media-downloader.tasks"

    private lazy var delegate: DownloadDelegate = {
        DownloadDelegate(plugin: self, metadataStore: metadataStore)
    }()

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.backgroundIdentifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
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
                self.startNewDownload(call: call, id: id, url: url, localPath: localPath)
            }
        } else {
            startNewDownload(call: call, id: id, url: url, localPath: localPath)
        }
    }

    private func startNewDownload(call: CAPPluginCall, id: String, url: URL, localPath: String) {
        var request = URLRequest(url: url)
        if let headers = call.getObject("headers") as? [String: String] {
            for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        }
        let downloadTask = session.downloadTask(with: request)
        let entry = TaskMetadataStore.Entry(
            id: id,
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
                try? FileManager.default.removeItem(atPath: entry.localPath)
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
        let exists = FileManager.default.fileExists(atPath: entry.localPath)
        let state: String = exists ? "completed" : "running"
        var task: [String: Any] = [
            "id": id,
            "state": state,
            "bytesDownloaded": entry.bytesDownloaded,
            "contentLength": entry.contentLength,
        ]
        if exists { task["localUrl"] = "file://" + entry.localPath }
        call.resolve(["task": task])
    }

    @objc func listTasks(_ call: CAPPluginCall) {
        var tasks: [[String: Any]] = []
        for entry in metadataStore.all() {
            let exists = FileManager.default.fileExists(atPath: entry.localPath)
            let state = exists ? "completed" : "running"
            var t: [String: Any] = [
                "id": entry.id,
                "state": state,
                "bytesDownloaded": entry.bytesDownloaded,
                "contentLength": entry.contentLength,
            ]
            if exists { t["localUrl"] = "file://" + entry.localPath }
            tasks.append(t)
        }
        call.resolve(["tasks": tasks])
    }

    @objc func resolveLocalUrl(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else { return call.reject("'url' is required") }
        if let entry = metadataStore.findByUrl(url),
           FileManager.default.fileExists(atPath: entry.localPath) {
            call.resolve(["localUrl": "file://" + entry.localPath])
        } else {
            call.resolve(["localUrl": NSNull()])
        }
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else { return call.reject("'url' is required") }
        if let entry = metadataStore.findByUrl(url) {
            try? FileManager.default.removeItem(atPath: entry.localPath)
            metadataStore.remove(id: entry.id)
        }
        call.resolve()
    }

    // ── Internals ─────────────────────────────────────────────────────────

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

    // ── Bridge helpers used by the delegate ───────────────────────────────

    func emit(event: String, data: [String: Any]) {
        notifyListeners(event, data: data)
    }
}
