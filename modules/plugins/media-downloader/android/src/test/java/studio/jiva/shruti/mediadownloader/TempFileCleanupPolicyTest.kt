package studio.jiva.shruti.mediadownloader

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TempFileCleanupPolicyTest {

    private val path = "/data/user/0/app/files/shruti/tracks/t-1/original.mp3"
    private val otherPath = "/data/user/0/app/files/shruti/tracks/t-2/original.mp3"
    private val stale = "$path#cdn2"
    private val sibling = "$path#cdn1"

    @Test
    fun `drops the partial when nothing else writes to that path`() {
        assertTrue(mayDeleteSupersededTemp(stale, path, emptyList()))
    }

    @Test
    fun `keeps the partial a live hedge sibling is writing`() {
        // The defect: candidate 1 holds the shared temp open, candidate 2's
        // download() retires a stale entry for the same file and unlinks it.
        assertFalse(
            mayDeleteSupersededTemp(
                stale,
                path,
                listOf(
                    TrackedWork(stale, path, finished = false),
                    TrackedWork(sibling, path, finished = false),
                ),
            ),
        )
    }

    @Test
    fun `drops the partial once every sibling has finished`() {
        assertTrue(
            mayDeleteSupersededTemp(
                stale,
                path,
                listOf(TrackedWork(sibling, path, finished = true)),
            ),
        )
    }

    @Test
    fun `a live download of a different file does not protect this temp`() {
        assertTrue(
            mayDeleteSupersededTemp(
                stale,
                path,
                listOf(TrackedWork("$otherPath#cdn1", otherPath, finished = false)),
            ),
        )
    }

    @Test
    fun `the entry being superseded never protects its own temp`() {
        // Its worker was just cancelled, and WorkManager reports that
        // asynchronously — so it can still look unfinished here. Reading it as
        // a live sibling would leave the recovery path unable to ever clear a
        // partial, which is the whole point of superseding stale work.
        assertTrue(
            mayDeleteSupersededTemp(
                stale,
                path,
                listOf(TrackedWork(stale, path, finished = false)),
            ),
        )
    }
}
