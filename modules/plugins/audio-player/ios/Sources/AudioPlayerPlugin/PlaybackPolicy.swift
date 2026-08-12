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
    ///
    /// `hasLiveItem` is false once the queue has run dry. The entries are still
    /// there (an append refills from them), but there is nothing playing to
    /// skip from, and a transport left live for a finished queue starts a
    /// lecture with no in-app player to show for it.
    static func remoteNextEnabled(queueIndex: Int, entryCount: Int, hasLiveItem: Bool) -> Bool {
        hasLiveItem && hasNext(queueIndex: queueIndex, entryCount: entryCount)
    }

    /// "Previous" stays available for the whole queue — past the first few
    /// seconds it restarts the current item — but is meaningless outside one,
    /// and after the queue has run dry.
    static func remotePreviousEnabled(entryCount: Int, hasLiveItem: Bool) -> Bool {
        hasLiveItem && entryCount > 1
    }

    /// Resume after an interruption only if playback was actually running
    /// when it began; `.shouldResume` alone would start a lecture the user
    /// had paused.
    static func shouldResumeAfterInterruption(wasPlaying: Bool, systemSuggestsResume: Bool) -> Bool {
        wasPlaying && systemSuggestsResume
    }
}
