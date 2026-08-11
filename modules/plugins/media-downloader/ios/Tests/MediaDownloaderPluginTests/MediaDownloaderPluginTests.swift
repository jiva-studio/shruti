import XCTest
@testable import MediaDownloaderPlugin

final class MediaDownloaderPluginTests: XCTestCase {
    func testTaskMetadataStoreRoundTrip() {
        let store = TaskMetadataStore(suiteName: "shruti.media-downloader.tests")
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
        XCTAssertNotNil(store.findByFileKey("/foo.mp3"))
    }

    /// A file saved while one CDN was active must still be found while
    /// another is: only the host differs, and the file did not move.
    func testFoundAfterTheActiveCdnChanged() {
        let store = TaskMetadataStore(suiteName: "shruti.media-downloader.tests")
        defer { store.remove(id: "y") }
        store.put(TaskMetadataStore.Entry(
            id: "y",
            fileKey: "/public/tracks/t-1/audio/original.mp3",
            url: "https://cdn-a.example.com/public/tracks/t-1/audio/original.mp3",
            localPath: "/tmp/t-1.mp3",
            bytesDownloaded: 1,
            contentLength: 1
        ))
        XCTAssertNotNil(store.findByFileKey("/public/tracks/t-1/audio/original.mp3"))
    }

    /// An entry written before the key existed is still addressable, so an
    /// upgrade does not orphan everything the user already downloaded.
    func testEntryFromAnOlderBuildFallsBackToItsPath() throws {
        let store = TaskMetadataStore(suiteName: "shruti.media-downloader.tests")
        defer { store.remove(id: "z") }
        let legacy = """
        {"id":"z","url":"https://cdn-a.example.com/public/tracks/t-2/audio/original.mp3",\
        "localPath":"/tmp/t-2.mp3","bytesDownloaded":1,"contentLength":1}
        """.replacingOccurrences(of: "\\\n", with: "")
        let decoded = try JSONDecoder().decode(
            TaskMetadataStore.Entry.self, from: Data(legacy.utf8)
        )
        XCTAssertNil(decoded.fileKey)
        store.put(decoded)
        XCTAssertNotNil(store.findByFileKey("/public/tracks/t-2/audio/original.mp3"))
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
