import Foundation

/**
 * The app-delegate half of the background downloader.
 *
 * When a transfer finishes while the app is not running, iOS relaunches it
 * into the background and calls
 * `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
 * The handler must be called back once the session has replayed everything it
 * buffered; leaving it uncalled makes the system progressively less willing to
 * relaunch the app for this session at all (#1880). `sessionSendsLaunchEvents`
 * is what asks for the relaunch — the forward is what pays for it.
 *
 * A namespace of its own rather than statics on `MediaDownloaderPlugin`: the
 * handler arrives during launch, before Capacitor has instantiated any plugin,
 * and the app target cannot spell a type whose name is also its module's.
 */
public enum MediaDownloaderBackgroundSession {

    /// The one background session this plugin runs.
    public static let identifier = "studio.jiva.shruti.mediadownloader"

    private static var handlers: [String: [() -> Void]] = [:]
    private static let lock = NSLock()

    /**
     * Forward from the app delegate. `false` means the identifier belongs to
     * somebody else's session and the caller still owns the handler.
     *
     * Handlers accumulate rather than replace, so a second batch arriving
     * before the first drains cannot drop one.
     */
    public static func handleEvents(
        identifier: String,
        completionHandler: @escaping () -> Void
    ) -> Bool {
        guard identifier == self.identifier else { return false }
        lock.lock()
        handlers[identifier, default: []].append(completionHandler)
        lock.unlock()
        return true
    }

    /// Called from `urlSessionDidFinishEvents(forBackgroundURLSession:)` once
    /// the replay has drained. UIKit wants the handler on the main thread.
    static func finish(for session: URLSession) {
        let identifier = session.configuration.identifier ?? self.identifier
        lock.lock()
        let pending = handlers.removeValue(forKey: identifier) ?? []
        lock.unlock()
        guard !pending.isEmpty else { return }
        DispatchQueue.main.async {
            for handler in pending { handler() }
        }
    }
}
