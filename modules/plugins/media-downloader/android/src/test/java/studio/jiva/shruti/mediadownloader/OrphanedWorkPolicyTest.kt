package studio.jiva.shruti.mediadownloader

import androidx.work.WorkInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.UUID

class OrphanedWorkPolicyTest {

    private val worker = UUID.randomUUID()
    private val newerWorker = UUID.randomUUID()

    @Test
    fun `a cancelled worker nobody tracks reports the cancellation`() {
        // What `cancel()` produces: the store entry is dropped synchronously,
        // before WorkManager delivers CANCELLED. The JS caller is awaiting a
        // terminal event, so this one must be emitted.
        assertEquals(
            OrphanedWorkAction.REPORT_CANCELLED,
            orphanedWorkAction(null, worker, WorkInfo.State.CANCELLED),
        )
    }

    @Test
    fun `a worker superseded by a re-kicked download stays silent`() {
        // `download()` cancels a stale ENQUEUED/BLOCKED worker, removes its
        // entry and enqueues a FRESH one under the same id. The old observer
        // must not emit: JS addresses events by id, so it would cancel the
        // download that just started.
        assertEquals(
            OrphanedWorkAction.DETACH,
            orphanedWorkAction(newerWorker, worker, WorkInfo.State.CANCELLED),
        )
    }

    @Test
    fun `a superseded worker stays silent whatever terminal state it reaches`() {
        for (state in listOf(WorkInfo.State.SUCCEEDED, WorkInfo.State.FAILED)) {
            assertEquals(
                OrphanedWorkAction.DETACH,
                orphanedWorkAction(newerWorker, worker, state),
            )
        }
    }

    @Test
    fun `an untracked worker that finished is reported as removed, not cancelled`() {
        // `deleteFile()` dropped the bookkeeping while the work was finishing:
        // there is no local file to hand back, but calling that a cancellation
        // would misreport a transfer that actually succeeded.
        assertEquals(
            OrphanedWorkAction.REPORT_REMOVED,
            orphanedWorkAction(null, worker, WorkInfo.State.SUCCEEDED),
        )
        assertEquals(
            OrphanedWorkAction.REPORT_REMOVED,
            orphanedWorkAction(null, worker, WorkInfo.State.FAILED),
        )
    }

    @Test
    fun `a worker that has not finished keeps its observer attached`() {
        for (state in listOf(WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED)) {
            assertEquals(OrphanedWorkAction.WAIT, orphanedWorkAction(null, worker, state))
        }
    }
}
