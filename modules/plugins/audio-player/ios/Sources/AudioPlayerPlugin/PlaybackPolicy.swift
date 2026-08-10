import Foundation

/// Playback decisions that don't need AVFoundation. Kept apart from the
/// plugin so both skip paths (lock screen and JS) share one definition of
/// "is there somewhere to go", the way Android derives everything from
/// ExoPlayer's timeline.
enum PlaybackPolicy {
    /// Is there an entry after `queueIndex`? iOS counterpart of
    /// `Player.hasNextMediaItem()`.
    static func hasNext(queueIndex: Int, entryCount: Int) -> Bool {
        queueIndex >= 0 && queueIndex + 1 < entryCount
    }

    /// A one-item queue must not offer "next": iOS honours the button from
    /// the lock screen, Control Center and AVRCP, and advancing empties the
    /// AVQueuePlayer.
    static func remoteNextEnabled(queueIndex: Int, entryCount: Int) -> Bool {
        hasNext(queueIndex: queueIndex, entryCount: entryCount)
    }

    /// "Previous" stays available for the whole queue — past the first few
    /// seconds it restarts the current item — but is meaningless outside one.
    static func remotePreviousEnabled(entryCount: Int) -> Bool {
        entryCount > 1
    }

    /// Resume after an interruption only if playback was actually running
    /// when it began; `.shouldResume` alone would start a lecture the user
    /// had paused.
    static func shouldResumeAfterInterruption(wasPlaying: Bool, systemSuggestsResume: Bool) -> Bool {
        wasPlaying && systemSuggestsResume
    }
}
