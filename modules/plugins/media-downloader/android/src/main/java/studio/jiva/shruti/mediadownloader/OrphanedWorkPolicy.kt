package studio.jiva.shruti.mediadownloader

import androidx.work.WorkInfo
import java.util.UUID

/**
 * What an observer should do when the `DownloadStore` no longer maps its
 * worker — the entry was dropped or replaced while the observer was still
 * attached.
 */
internal enum class OrphanedWorkAction {
    /** Not terminal yet: stay attached and wait for a final state. */
    WAIT,

    /**
     * A newer worker owns this id now, so this observer speaks for work
     * nobody is waiting on. Stop observing WITHOUT emitting: the JS side
     * addresses events by `id`, so any event here would settle the
     * freshly-started download instead.
     */
    DETACH,

    /** Nothing tracks this id any more and the work was cancelled. */
    REPORT_CANCELLED,

    /**
     * The work finished (succeeded or failed) after its bookkeeping was
     * deleted, so there is no local file to hand back. Still terminal for
     * whoever is awaiting it — but it is not a cancellation.
     */
    REPORT_REMOVED,
}

/**
 * Decide how to handle a `WorkInfo` update whose worker has no
 * `DownloadStore` entry.
 *
 * Absence alone is ambiguous — the entry can be gone for two very different
 * reasons:
 *  - `cancel()` / `deleteFile()` removed it (`trackedWorkerId == null`).
 *    `cancel()` does so synchronously, BEFORE WorkManager delivers
 *    CANCELLED, so this is the path a user-initiated cancel actually takes,
 *    and the JS caller is still awaiting a terminal event.
 *  - `download()` superseded it: a stale non-RUNNING worker is cancelled and
 *    a FRESH one enqueued under the same id (the "re-kick an interrupted
 *    download" recovery). The store then maps the id to the new worker, and
 *    the old observer must stay quiet or it would cancel the new download.
 */
internal fun orphanedWorkAction(
    trackedWorkerId: UUID?,
    workerId: UUID,
    state: WorkInfo.State,
): OrphanedWorkAction {
    if (trackedWorkerId != null && trackedWorkerId != workerId) return OrphanedWorkAction.DETACH
    if (!state.isFinished) return OrphanedWorkAction.WAIT
    return if (state == WorkInfo.State.CANCELLED) {
        OrphanedWorkAction.REPORT_CANCELLED
    } else {
        OrphanedWorkAction.REPORT_REMOVED
    }
}
