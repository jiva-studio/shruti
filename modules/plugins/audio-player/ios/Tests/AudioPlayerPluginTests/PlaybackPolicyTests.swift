import XCTest
@testable import AudioPlayerPlugin

/// The decisions behind #1626: a one-item queue must not offer skips, and an
/// interruption must not resume what the user had paused. Plus #1740: a queue
/// that has run dry offers neither.
final class PlaybackPolicyTests: XCTestCase {
    func testSingleItemQueueOffersNoSkips() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 0, entryCount: 1))
        XCTAssertFalse(
            PlaybackPolicy.remoteNextEnabled(queueIndex: 0, entryCount: 1, hasLiveItem: true))
        XCTAssertFalse(PlaybackPolicy.remotePreviousEnabled(entryCount: 1, hasLiveItem: true))
    }

    func testEmptyQueueOffersNoSkips() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 0, entryCount: 0))
        XCTAssertFalse(
            PlaybackPolicy.remoteNextEnabled(queueIndex: 0, entryCount: 0, hasLiveItem: true))
        XCTAssertFalse(PlaybackPolicy.remotePreviousEnabled(entryCount: 0, hasLiveItem: true))
    }

    func testQueueWithMoreItemsAheadOffersBothSkips() {
        XCTAssertTrue(PlaybackPolicy.hasNext(queueIndex: 1, entryCount: 3))
        XCTAssertTrue(
            PlaybackPolicy.remoteNextEnabled(queueIndex: 1, entryCount: 3, hasLiveItem: true))
        XCTAssertTrue(PlaybackPolicy.remotePreviousEnabled(entryCount: 3, hasLiveItem: true))
    }

    func testLastItemOfQueueKeepsPreviousButNotNext() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 2, entryCount: 3))
        XCTAssertFalse(
            PlaybackPolicy.remoteNextEnabled(queueIndex: 2, entryCount: 3, hasLiveItem: true))
        XCTAssertTrue(PlaybackPolicy.remotePreviousEnabled(entryCount: 3, hasLiveItem: true))
    }

    /// The queue played out: the entries survive (an append refills from them)
    /// but nothing is loaded, so the lock-screen transport must go quiet.
    func testDryQueueOffersNoSkipsEvenThoughEntriesRemain() {
        XCTAssertFalse(
            PlaybackPolicy.remoteNextEnabled(queueIndex: 0, entryCount: 3, hasLiveItem: false))
        XCTAssertFalse(PlaybackPolicy.remotePreviousEnabled(entryCount: 3, hasLiveItem: false))
    }

    func testOutOfRangeIndexNeverAdvances() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: -1, entryCount: 3))
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 5, entryCount: 3))
    }

    func testInterruptionResumesOnlyWhatWasPlaying() {
        XCTAssertTrue(
            PlaybackPolicy.shouldResumeAfterInterruption(wasPlaying: true, systemSuggestsResume: true))
        XCTAssertFalse(
            PlaybackPolicy.shouldResumeAfterInterruption(wasPlaying: false, systemSuggestsResume: true))
        XCTAssertFalse(
            PlaybackPolicy.shouldResumeAfterInterruption(wasPlaying: true, systemSuggestsResume: false))
    }
}
