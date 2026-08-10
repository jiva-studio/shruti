import XCTest
@testable import AudioPlayerPlugin

/// The decisions behind #1626: a one-item queue must not offer skips, and an
/// interruption must not resume what the user had paused.
final class PlaybackPolicyTests: XCTestCase {
    func testSingleItemQueueOffersNoSkips() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 0, entryCount: 1))
        XCTAssertFalse(PlaybackPolicy.remoteNextEnabled(queueIndex: 0, entryCount: 1))
        XCTAssertFalse(PlaybackPolicy.remotePreviousEnabled(entryCount: 1))
    }

    func testEmptyQueueOffersNoSkips() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 0, entryCount: 0))
        XCTAssertFalse(PlaybackPolicy.remoteNextEnabled(queueIndex: 0, entryCount: 0))
        XCTAssertFalse(PlaybackPolicy.remotePreviousEnabled(entryCount: 0))
    }

    func testQueueWithMoreItemsAheadOffersBothSkips() {
        XCTAssertTrue(PlaybackPolicy.hasNext(queueIndex: 1, entryCount: 3))
        XCTAssertTrue(PlaybackPolicy.remoteNextEnabled(queueIndex: 1, entryCount: 3))
        XCTAssertTrue(PlaybackPolicy.remotePreviousEnabled(entryCount: 3))
    }

    func testLastItemOfQueueKeepsPreviousButNotNext() {
        XCTAssertFalse(PlaybackPolicy.hasNext(queueIndex: 2, entryCount: 3))
        XCTAssertFalse(PlaybackPolicy.remoteNextEnabled(queueIndex: 2, entryCount: 3))
        XCTAssertTrue(PlaybackPolicy.remotePreviousEnabled(entryCount: 3))
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
