package studio.jiva.shruti.mediadownloader

import androidx.work.WorkInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.UUID

class WorkUpdatePolicyTest {

    private val worker = UUID.randomUUID()
    private val newerWorker = UUID.randomUUID()

    private val finished = listOf(
        WorkInfo.State.SUCCEEDED,
        WorkInfo.State.FAILED,
        WorkInfo.State.CANCELLED,
    )
    private val unfinished = listOf(
        WorkInfo.State.ENQUEUED,
        WorkInfo.State.RUNNING,
        WorkInfo.State.BLOCKED,
    )

    // ── Superseded by a re-kicked download ────────────────────────────────
    // `download()` cancels a stale worker and enqueues a fresh one under the
    // SAME id. The old observer must stay silent in every window, including
    // the one where the store still maps the old worker (between
    // `cancelWorkById` and `store.remove`) — an event there would settle the
    // download that has just started.

    @Test
    fun `a superseded worker stays silent while the store still maps it`() {
        for (state in finished + unfinished) {
            assertEquals(
                "state=$state",
                WorkUpdateAction.DETACH,
                workUpdateAction(
                    superseded = true,
                    tracksThisWorker = true,
                    trackedWorkerId = worker,
                    workerId = worker,
                    state = state,
                ),
            )
        }
    }

    @Test
    fun `a superseded worker stays silent once its entry is gone`() {
        assertEquals(
            WorkUpdateAction.DETACH,
            workUpdateAction(true, false, null, worker, WorkInfo.State.CANCELLED),
        )
    }

    @Test
    fun `a worker the store re-pointed at a newer one stays silent`() {
        for (state in finished) {
            assertEquals(
                "state=$state",
                WorkUpdateAction.DETACH,
                workUpdateAction(false, false, newerWorker, worker, state),
            )
        }
    }

    // ── Genuine cancellation ──────────────────────────────────────────────

    @Test
    fun `a cancelled worker nobody tracks reports the cancellation`() {
        // `cancel()` drops the entry synchronously, before WorkManager
        // delivers CANCELLED. The JS caller is awaiting a terminal event.
        assertEquals(
            WorkUpdateAction.REPORT_CANCELLED,
            workUpdateAction(false, false, null, worker, WorkInfo.State.CANCELLED),
        )
    }

    @Test
    fun `a cancellation that beat the store removal is handled on the normal path`() {
        // Same user cancel, other ordering: the entry is still there, so the
        // regular terminal switch emits — it must NOT be silenced.
        assertEquals(
            WorkUpdateAction.PROCEED,
            workUpdateAction(false, true, worker, worker, WorkInfo.State.CANCELLED),
        )
    }

    // ── Bookkeeping deleted mid-flight ────────────────────────────────────

    @Test
    fun `an untracked worker that finished is reported as removed, not cancelled`() {
        for (state in listOf(WorkInfo.State.SUCCEEDED, WorkInfo.State.FAILED)) {
            assertEquals(
                "state=$state",
                WorkUpdateAction.REPORT_REMOVED,
                workUpdateAction(false, false, null, worker, state),
            )
        }
    }

    @Test
    fun `an untracked worker that has not finished keeps its observer attached`() {
        for (state in unfinished) {
            assertEquals(
                "state=$state",
                WorkUpdateAction.WAIT,
                workUpdateAction(false, false, null, worker, state),
            )
        }
    }

    // ── Normal life ───────────────────────────────────────────────────────

    @Test
    fun `a tracked worker is always handled on the normal path`() {
        for (state in finished + unfinished) {
            assertEquals(
                "state=$state",
                WorkUpdateAction.PROCEED,
                workUpdateAction(false, true, worker, worker, state),
            )
        }
    }
}
