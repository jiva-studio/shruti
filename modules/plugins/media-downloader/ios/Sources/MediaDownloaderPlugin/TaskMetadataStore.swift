import Foundation

/**
 * Per-task metadata persisted across app launches via UserDefaults.
 * Mirrors `DownloadStore` on the Android side.
 *
 * Holds the file key, the URL it was fetched from, the absolute on-disk
 * path, and the byte counts the transfer ended on, so `listTasks()` and
 * `getTask()` can answer questions about downloads that finished while the
 * app was suspended.
 *
 * ONE USERDEFAULTS KEY PER ENTRY, which is what Android keeps in its own
 * SharedPreferences file. The whole store used to live in a single JSON
 * blob that every write read, mutated and re-encoded — from URLSession's
 * delegate queue and Capacitor's bridge queue both — so two overlapping
 * downloads dropped each other's entries; and a dropped entry made
 * `didFinishDownloadingTo` return before the move, leaving no event, no
 * file and a JS promise that never settled (#1836). Separate keys have no
 * shared value to lose, and no write re-encodes the user's whole offline
 * library. UserDefaults itself is thread-safe.
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
        /**
         * The transfer succeeded, so this is no longer a task — only the index
         * that maps `fileKey` back to the saved file, which `resolveLocalUrl`
         * and `deleteFile` both go through. Kept rather than pruned for
         * exactly that reason: dropping it on success would orphan every
         * downloaded lecture. Marking it is what lets start-up tell an index
         * whose file is gone from a download still in flight.
         *
         * Optional for decoding only, like `fileKey`: an entry written before
         * the flag existed reads as "not finished", which only means start-up
         * leaves it alone.
         */
        var completed: Bool? = nil

        var isCompleted: Bool { completed ?? false }

        /// What this entry is indexed under. An entry written before the key
        /// existed falls back to the path of its URL, which is the same value.
        var resolvedFileKey: String? { fileKey ?? URL(string: url)?.path }
    }

    private let defaults: UserDefaults
    /// Every entry lives under this prefix plus its id.
    private let keyPrefix: String
    /// The single-blob key earlier builds wrote. Read once, then retired.
    private let legacyKey: String

    init(suiteName: String) {
        // The standard domain, JSON per value, so the format stays
        // human-inspectable when debugging with `defaults read` on the
        // simulator.
        self.defaults = .standard
        self.legacyKey = suiteName
        self.keyPrefix = suiteName + "."
        migrateLegacyBlob()
    }

    func put(_ entry: Entry) {
        guard let data = try? JSONEncoder().encode(entry) else { return }
        defaults.set(data, forKey: key(for: entry.id))
    }

    func get(id: String) -> Entry? {
        decode(defaults.data(forKey: key(for: id)))
    }

    /** Match a live URLSession task back to its entry — the one lookup that
     *  legitimately keys on the address, since that is what the task carries. */
    func findByUrl(_ url: String) -> Entry? {
        all().first(where: { $0.url == url })
    }

    /**
     * Every entry for a file, not the first.
     *
     * A key owns as many entries as the caller raced CDN candidates for it:
     * they differ by id and all name the one shared destination. Answering
     * with a single match stranded the siblings — bookkeeping that outlives
     * the file it points at, and that `resolveLocalUrl` still answers with
     * after the lecture was deleted. Android's `findAllByFileKey`.
     */
    func findAllByFileKey(_ fileKey: String) -> [Entry] {
        all().filter { keyOf($0) == fileKey }
    }

    private func keyOf(_ entry: Entry) -> String? {
        entry.resolvedFileKey
    }

    func all() -> [Entry] {
        // UserDefaults has no prefix query, so this is the enumeration Android
        // gets for free from a store-private SharedPreferences file. Called by
        // `listTasks` / `resolveLocalUrl` / `deleteFile` and once at start-up —
        // never on the progress path, which is what used to walk the store
        // many times a second.
        var out: [Entry] = []
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(keyPrefix) {
            guard let entry = decode(value as? Data) else { continue }
            out.append(entry)
        }
        return out
    }

    func remove(id: String) {
        defaults.removeObject(forKey: key(for: id))
    }

    private func key(for id: String) -> String { keyPrefix + id }

    private func decode(_ data: Data?) -> Entry? {
        guard let data = data else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }

    /// Split the one-blob store earlier builds wrote into per-entry keys, so
    /// an upgrade keeps pointing at everything already on disk. Runs once —
    /// the blob is removed afterwards — and never overwrites an id that has a
    /// key of its own already, which is the newer of the two.
    private func migrateLegacyBlob() {
        guard let data = defaults.data(forKey: legacyKey) else { return }
        if let map = try? JSONDecoder().decode([String: Entry].self, from: data) {
            for (id, entry) in map where defaults.data(forKey: key(for: id)) == nil {
                guard let encoded = try? JSONEncoder().encode(entry) else { continue }
                defaults.set(encoded, forKey: key(for: id))
            }
        }
        defaults.removeObject(forKey: legacyKey)
    }
}
