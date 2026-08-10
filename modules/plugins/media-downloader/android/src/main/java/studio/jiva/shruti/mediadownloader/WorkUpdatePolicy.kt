package studio.jiva.shruti.mediadownloader

import androidx.work.WorkInfo
import java.util.UUID

/** What an observer should do with a `WorkInfo` update. */
internal enum class WorkUpdateAction {
    /** This observer still owns the work: report progress/state as usual. */
    PROCEED,

    /** Orphaned but not finished: stay attached, say nothing. */
    WAIT,

    /**
     * This observer speaks for work nobody is waiting on. Stop observing
     * WITHOUT emitting: the JS side addresses events by `id`, so an event
     * here would settle a download started by someone else under that id.
     */
    DETACH,

    /** Nothing tracks this id any more and the work was cancelled. */
    REPORT_CANCELLED,

    /**
     * The work finished (succeeded or failed) after its bookkeeping was
     * deleted, so there is no local file to hand back. Terminal for whoever
     * is awaiting it — but it is not a cancellation.
     */
    REPORT_REMOVED,
}

/**
 * Decide how an observer should handle a `WorkInfo` update.
 *
 * The delicate part is telling a cancellation the caller is waiting for from
 * one it must never hear about:
 *  - `cancel()` / `deleteFile()` drop the store entry. `cancel()` does so
 *    synchronously, BEFORE WorkManager delivers CANCELLED, so that is the
 *    path a user-initiated cancel actually takes and the JS caller is still
 *    awaiting a terminal event.
 *  - `download()` SUPERSEDES a stale non-RUNNING worker: it cancels it and
 *    enqueues a FRESH request under the same id (the recovery that re-kicks
 *    an interrupted download on every app reopen). That cancellation belongs
 *    to work nobody awaits, while the id now belongs to a download that has
 *    just started — reporting it would cancel the replacement. The window
 *    where the store STILL maps the old worker is why `superseded` is an
 *    explicit input and not inferred from the store.
 *
 * @param superseded the worker was replaced by `download()`
 * @param tracksThisWorker the store has an entry pointing at this worker
 * @param trackedWorkerId the worker the store currently maps this id to
 */
internal fun workUpdateAction(
    superseded: Boolean,
    tracksThisWorker: Boolean,
    trackedWorkerId: UUID?,
    workerId: UUID,
    state: WorkInfo.State,
): WorkUpdateAction {
    if (superseded) return WorkUpdateAction.DETACH
    if (tracksThisWorker) return WorkUpdateAction.PROCEED
    if (trackedWorkerId != null && trackedWorkerId != workerId) return WorkUpdateAction.DETACH
    if (!state.isFinished) return WorkUpdateAction.WAIT
    return if (state == WorkInfo.State.CANCELLED) {
        WorkUpdateAction.REPORT_CANCELLED
    } else {
        WorkUpdateAction.REPORT_REMOVED
    }
}
