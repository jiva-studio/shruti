import XCTest
@testable import MediaDownloaderPlugin

final class MediaDownloaderPluginTests: XCTestCase {
    func testTaskMetadataStoreRoundTrip() {
        let store = TaskMetadataStore(suiteName: "lectorium.media-downloader.tests")
        defer { store.remove(id: "x") }
        let entry = TaskMetadataStore.Entry(
            id: "x",
            fileKey: "/foo.mp3",
            url: "https://example.com/foo.mp3",
            localPath: "/tmp/foo.mp3",
            bytesDownloaded: 100,
            contentLength: 200
        )
        store.put(entry)
        let read = store.get(id: "x")
        XCTAssertEqual(read?.id, "x")
        XCTAssertEqual(read?.bytesDownloaded, 100)
        XCTAssertEqual(read?.contentLength, 200)
        XCTAssertNotNil(store.findByUrl("https://example.com/foo.mp3"))
        XCTAssertFalse(store.findAllByFileKey("/foo.mp3").isEmpty)
    }

    /// A file saved while one CDN was active must still be found while
    /// another is: only the host differs, and the file did not move.
    func testFoundAfterTheActiveCdnChanged() {
        let store = TaskMetadataStore(suiteName: "lectorium.media-downloader.tests")
        defer { store.remove(id: "y") }
        store.put(TaskMetadataStore.Entry(
            id: "y",
            fileKey: "/public/tracks/t-1/audio/original.mp3",
            url: "https://cdn-a.example.com/public/tracks/t-1/audio/original.mp3",
            localPath: "/tmp/t-1.mp3",
            bytesDownloaded: 1,
            contentLength: 1
        ))
        XCTAssertFalse(store.findAllByFileKey("/public/tracks/t-1/audio/original.mp3").isEmpty)
    }

    /// An entry written before the key existed is still addressable, so an
    /// upgrade does not orphan everything the user already downloaded.
    func testEntryFromAnOlderBuildFallsBackToItsPath() throws {
        let store = TaskMetadataStore(suiteName: "lectorium.media-downloader.tests")
        defer { store.remove(id: "z") }
        let legacy = """
        {"id":"z","url":"https://cdn-a.example.com/public/tracks/t-2/audio/original.mp3",\
        "localPath":"/tmp/t-2.mp3","bytesDownloaded":1,"contentLength":1}
        """.replacingOccurrences(of: "\\\n", with: "")
        let decoded = try JSONDecoder().decode(
            TaskMetadataStore.Entry.self, from: Data(legacy.utf8)
        )
        XCTAssertNil(decoded.fileKey)
        // No `completed` key either: it reads as unfinished, which is what
        // keeps start-up from reconciling an entry it knows nothing about.
        XCTAssertFalse(decoded.isCompleted)
        store.put(decoded)
        XCTAssertFalse(store.findAllByFileKey("/public/tracks/t-2/audio/original.mp3").isEmpty)
    }

    /// Entries live under a key of their own, so a write for one download
    /// cannot take another's entry with it — the lost update that made a
    /// finished transfer emit no event at all.
    func testEntriesDoNotShareOneValue() {
        let store = TaskMetadataStore(suiteName: "lectorium.media-downloader.tests")
        defer {
            store.remove(id: "a")
            store.remove(id: "b")
        }
        store.put(TaskMetadataStore.Entry(
            id: "a",
            fileKey: "/a.mp3",
            url: "https://cdn.example.com/a.mp3",
            localPath: "/tmp/a.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        ))
        store.put(TaskMetadataStore.Entry(
            id: "b",
            fileKey: "/b.mp3",
            url: "https://cdn.example.com/b.mp3",
            localPath: "/tmp/b.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        ))
        XCTAssertNotNil(store.get(id: "a"))
        XCTAssertNotNil(store.get(id: "b"))
        store.remove(id: "a")
        XCTAssertNil(store.get(id: "a"))
        XCTAssertNotNil(store.get(id: "b"))
    }

    /// A key owns one entry per raced CDN candidate; deleting the lecture has
    /// to take all of them, so none is left answering for a file that is gone.
    func testEveryEntryForAFileKeyIsFound() {
        let store = TaskMetadataStore(suiteName: "lectorium.media-downloader.tests")
        defer {
            store.remove(id: "cand-1")
            store.remove(id: "cand-2")
        }
        for (id, host) in [("cand-1", "cdn-a"), ("cand-2", "cdn-b")] {
            store.put(TaskMetadataStore.Entry(
                id: id,
                fileKey: "/public/tracks/t-3/audio/original.mp3",
                url: "https://\(host).example.com/public/tracks/t-3/audio/original.mp3",
                localPath: "/tmp/t-3.mp3",
                bytesDownloaded: 0,
                contentLength: 0
            ))
        }
        XCTAssertEqual(store.findAllByFileKey("/public/tracks/t-3/audio/original.mp3").count, 2)
    }

    /// The single-blob store earlier builds wrote is split into per-entry keys
    /// on first construction, so an upgrade keeps pointing at what is on disk.
    func testLegacyBlobIsMigratedToPerEntryKeys() {
        let suite = "lectorium.media-downloader.migration-tests"
        let legacy = "{\"m\":{\"id\":\"m\",\"fileKey\":\"/m.mp3\","
            + "\"url\":\"https://cdn.example.com/m.mp3\",\"localPath\":\"/tmp/m.mp3\","
            + "\"bytesDownloaded\":7,\"contentLength\":7}}"
        UserDefaults.standard.set(Data(legacy.utf8), forKey: suite)

        let store = TaskMetadataStore(suiteName: suite)
        defer { store.remove(id: "m") }

        XCTAssertNil(UserDefaults.standard.data(forKey: suite))
        XCTAssertEqual(store.get(id: "m")?.localPath, "/tmp/m.mp3")
        XCTAssertEqual(store.get(id: "m")?.bytesDownloaded, 7)
        XCTAssertFalse(store.findAllByFileKey("/m.mp3").isEmpty)
    }

    /// A blob that does not decode is all-or-nothing, so retiring it unread
    /// would take the whole offline index with it — the audio stays on disk,
    /// unplayable and undeletable. Keep it and try again next launch.
    func testACorruptLegacyBlobIsKept() {
        let suite = "lectorium.media-downloader.corrupt-migration-tests"
        let corrupt = "{\"m\":{\"id\":\"m\",\"url\":"
        UserDefaults.standard.set(Data(corrupt.utf8), forKey: suite)
        defer { UserDefaults.standard.removeObject(forKey: suite) }

        _ = TaskMetadataStore(suiteName: suite)

        XCTAssertNotNil(UserDefaults.standard.data(forKey: suite))
        XCTAssertEqual(UserDefaults.standard.data(forKey: suite), Data(corrupt.utf8))
    }

    /// A blob whose entries decode is still migrated and retired, so the
    /// keep-on-failure above cannot be mistaken for "never migrate".
    func testAReadableLegacyBlobIsStillRetired() {
        let suite = "lectorium.media-downloader.readable-migration-tests"
        let legacy = "{\"k\":{\"id\":\"k\",\"fileKey\":\"/k.mp3\","
            + "\"url\":\"https://cdn.example.com/k.mp3\",\"localPath\":\"/tmp/k.mp3\","
            + "\"bytesDownloaded\":1,\"contentLength\":1}}"
        UserDefaults.standard.set(Data(legacy.utf8), forKey: suite)

        let store = TaskMetadataStore(suiteName: suite)
        defer { store.remove(id: "k") }

        XCTAssertNil(UserDefaults.standard.data(forKey: suite))
        XCTAssertEqual(store.get(id: "k")?.localPath, "/tmp/k.mp3")
    }

    /// Removing an entry must take it out of the lookups too — an index that
    /// kept answering for it would hand `resolveLocalUrl` a deleted lecture.
    func testLookupsFollowRemoval() {
        let suite = "lectorium.media-downloader.index-tests"
        let store = TaskMetadataStore(suiteName: suite)
        defer { store.remove(id: "idx-1") }
        let url = "https://cdn-a.example.com/public/tracks/t-7/audio/original.mp3"
        store.put(TaskMetadataStore.Entry(
            id: "idx-1",
            fileKey: "/public/tracks/t-7/audio/original.mp3",
            url: url,
            localPath: "/tmp/t-7.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        ))
        XCTAssertEqual(store.findAllByFileKey("/public/tracks/t-7/audio/original.mp3").count, 1)
        XCTAssertNotNil(store.findByUrl(url))

        store.remove(id: "idx-1")
        XCTAssertTrue(store.findAllByFileKey("/public/tracks/t-7/audio/original.mp3").isEmpty)
        XCTAssertNil(store.findByUrl(url))
    }

    /// An entry written after the first lookup built the index is still found
    /// by the next one.
    func testAnEntryAddedAfterTheFirstLookupIsFound() {
        let suite = "lectorium.media-downloader.index-late-tests"
        let store = TaskMetadataStore(suiteName: suite)
        defer { store.remove(id: "late-1") }
        XCTAssertTrue(store.findAllByFileKey("/late.mp3").isEmpty)
        store.put(TaskMetadataStore.Entry(
            id: "late-1",
            fileKey: "/late.mp3",
            url: "https://cdn.example.com/late.mp3",
            localPath: "/tmp/late.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        ))
        XCTAssertEqual(store.findAllByFileKey("/late.mp3").count, 1)
    }

    /// In-flight counts are persisted, but on a byte budget — not per chunk,
    /// which is the read-modify-write round 9 removed.
    func testProgressIsPersistedOnlyEveryFewMegabytes() {
        let interval = DownloadDelegate.progressPersistInterval
        XCTAssertFalse(
            DownloadDelegate.shouldPersistProgress(lastPersisted: 0, totalBytesWritten: 64 * 1024)
        )
        XCTAssertFalse(
            DownloadDelegate.shouldPersistProgress(lastPersisted: 0, totalBytesWritten: interval - 1)
        )
        XCTAssertTrue(
            DownloadDelegate.shouldPersistProgress(lastPersisted: 0, totalBytesWritten: interval)
        )
        XCTAssertFalse(
            DownloadDelegate.shouldPersistProgress(
                lastPersisted: interval, totalBytesWritten: interval + 1
            )
        )
        XCTAssertTrue(
            DownloadDelegate.shouldPersistProgress(
                lastPersisted: interval, totalBytesWritten: 2 * interval
            )
        )
    }

    /// A task that finished while the app was dead is not in the session's
    /// task list any more, so the id can only come back from the store, keyed
    /// by the URL the task still carries. A store built by a fresh process
    /// stands in for the relaunch.
    func testATaskIdSurvivesTheProcessAndIsFoundByItsUrl() {
        let suite = "lectorium.media-downloader.relaunch-tests"
        let url = "https://cdn-a.example.com/public/tracks/t-4/audio/original.mp3"
        let writer = TaskMetadataStore(suiteName: suite)
        writer.put(TaskMetadataStore.Entry(
            id: "relaunch-1",
            fileKey: "/public/tracks/t-4/audio/original.mp3",
            url: url,
            localPath: "/tmp/t-4.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        ))

        let afterRelaunch = TaskMetadataStore(suiteName: suite)
        defer { afterRelaunch.remove(id: "relaunch-1") }
        XCTAssertEqual(afterRelaunch.findByUrl(url)?.id, "relaunch-1")
        XCTAssertNil(afterRelaunch.findByUrl("https://cdn-b.example.com/other.mp3"))
    }

    /// A losing CDN candidate that outlives the JS hedge must not unlink the
    /// winner's finished lecture: both name one destination.
    func testAFailingCandidateSparesASiblingsFinishedFile() {
        let winner = TaskMetadataStore.Entry(
            id: "cand-winner",
            fileKey: "/public/tracks/t-5/audio/original.mp3",
            url: "https://cdn-a.example.com/public/tracks/t-5/audio/original.mp3",
            localPath: "/tmp/t-5.mp3",
            bytesDownloaded: 10,
            contentLength: 10,
            completed: true
        )
        let loser = TaskMetadataStore.Entry(
            id: "cand-loser",
            fileKey: "/public/tracks/t-5/audio/original.mp3",
            url: "https://cdn-b.example.com/public/tracks/t-5/audio/original.mp3",
            localPath: "/tmp/t-5.mp3",
            bytesDownloaded: 0,
            contentLength: 0
        )
        XCTAssertFalse(
            DownloadDelegate.mayDeleteDestination(entry: loser, siblings: [winner, loser])
        )
        // Its own completion protects an entry too, whatever the siblings say.
        XCTAssertFalse(
            DownloadDelegate.mayDeleteDestination(entry: winner, siblings: [winner, loser])
        )
    }

    /// With nothing finished at that path, the partial the failing task left
    /// behind is still swept — that is what keeps `resolveLocalUrl` from
    /// handing back a truncated file.
    func testAFailingDownloadStillSweepsItsOwnPartial() {
        let entry = TaskMetadataStore.Entry(
            id: "solo",
            fileKey: "/public/tracks/t-6/audio/original.mp3",
            url: "https://cdn-a.example.com/public/tracks/t-6/audio/original.mp3",
            localPath: "/tmp/t-6.mp3",
            bytesDownloaded: 3,
            contentLength: 9
        )
        XCTAssertTrue(DownloadDelegate.mayDeleteDestination(entry: entry, siblings: [entry]))
        XCTAssertTrue(DownloadDelegate.mayDeleteDestination(entry: entry, siblings: []))
    }

    /// URLSession reports a 403/404/502 through the *success* callback, where
    /// the body is the CDN's error document. Only a 2xx may become a lecture.
    func testOnlyASuccessfulStatusMayBeSaved() {
        XCTAssertTrue(DownloadDelegate.isSuccessful(statusCode: 200))
        XCTAssertTrue(DownloadDelegate.isSuccessful(statusCode: 206))
        XCTAssertTrue(DownloadDelegate.isSuccessful(statusCode: 299))
        XCTAssertFalse(DownloadDelegate.isSuccessful(statusCode: 304))
        XCTAssertFalse(DownloadDelegate.isSuccessful(statusCode: 403))
        XCTAssertFalse(DownloadDelegate.isSuccessful(statusCode: 404))
        XCTAssertFalse(DownloadDelegate.isSuccessful(statusCode: 502))
    }
}
