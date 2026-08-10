import Foundation

/**
 * Per-task metadata persisted across app launches via UserDefaults.
 * Mirrors `DownloadStore` on the Android side.
 *
 * Holds the file key, the URL it was fetched from, the absolute on-disk
 * path, and the most recent byte counts so `listTasks()` and `getTask()`
 * can answer questions about downloads that finished while the app was
 * suspended.
 */
final class TaskMetadataStore {

    struct Entry: Codable {
        let id: String
        /**
         * What names the file, independent of the host it came from. Several
         * CDNs serve the same file and the active one changes under the app,
         * so an entry found by URL disappeared the moment the region did —
         * and the caller read that as a lost download.
         *
         * Optional for decoding only: entries written by a build before the
         * key existed fall back to the path of their URL, which is the same
         * value, so an upgrade keeps finding what it already downloaded.
         */
        let fileKey: String?
        let url: String
        var localPath: String
        var bytesDownloaded: Int64
        var contentLength: Int64
    }

    private let defaults: UserDefaults
    private let storeKey: String

    init(suiteName: String) {
        // Stored in the standard UserDefaults under one composite key,
        // serialized as JSON to keep the format human-inspectable when
        // debugging with `defaults read` on the simulator.
        self.defaults = .standard
        self.storeKey = suiteName
    }

    func put(_ entry: Entry) {
        var all = loadAll()
        all[entry.id] = entry
        save(all)
    }

    func get(id: String) -> Entry? {
        loadAll()[id]
    }

    /** Match a live URLSession task back to its entry — the one lookup that
     *  legitimately keys on the address, since that is what the task carries. */
    func findByUrl(_ url: String) -> Entry? {
        loadAll().values.first(where: { $0.url == url })
    }

    func findByFileKey(_ fileKey: String) -> Entry? {
        loadAll().values.first(where: { keyOf($0) == fileKey })
    }

    private func keyOf(_ entry: Entry) -> String? {
        entry.fileKey ?? URL(string: entry.url)?.path
    }

    func all() -> [Entry] {
        Array(loadAll().values)
    }

    func remove(id: String) {
        var all = loadAll()
        all.removeValue(forKey: id)
        save(all)
    }

    private func loadAll() -> [String: Entry] {
        guard let data = defaults.data(forKey: storeKey) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private func save(_ map: [String: Entry]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        defaults.set(data, forKey: storeKey)
    }
}
