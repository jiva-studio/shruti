import XCTest
@testable import MediaDownloaderPlugin

final class MediaDownloaderPluginTests: XCTestCase {
    func testTaskMetadataStoreRoundTrip() {
        let store = TaskMetadataStore(suiteName: "shruti.media-downloader.tests")
        defer { store.remove(id: "x") }
        let entry = TaskMetadataStore.Entry(
            id: "x",
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
    }
}
