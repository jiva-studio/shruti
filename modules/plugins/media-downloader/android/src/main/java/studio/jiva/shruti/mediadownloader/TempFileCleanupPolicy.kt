package studio.jiva.shruti.mediadownloader

/** A tracked download reduced to what the temp-cleanup decision needs. */
internal data class TrackedWork(
    val id: String,
    val localPath: String,
    val finished: Boolean,
)

/**
 * Whether superseding [supersededId] may delete the `.download` temp next to
 * [localPath].
 *
 * An id used to be the file, so retiring a stale entry could drop its partial
 * unconditionally. It isn't any more: the JS layer hedges CDN candidates for
 * one lecture against each other, and it keeps the id per-host while pointing
 * every candidate at ONE destination — so the path named by the entry we are
 * retiring can be the temp a live sibling is filling right now. Deleting it
 * unlinks the writer's inode: it fills a file nobody can see, its final
 * rename fails, and the whole lecture is fetched a second time.
 *
 * The temp's `FileChannel` lock cannot arbitrate this. It is held inside the
 * worker while the delete happens out here, and after an unlink the two
 * workers hold locks on different inodes.
 *
 * So: keep the temp while any OTHER tracked download writes to the same path
 * and hasn't finished. Work WorkManager no longer knows is not in [tracked]
 * and holds nothing. Being unsure costs one stale temp, which the next worker
 * to claim the path truncates; being wrong costs the user the download twice.
 */
internal fun mayDeleteSupersededTemp(
    supersededId: String,
    localPath: String,
    tracked: List<TrackedWork>,
): Boolean = tracked.none { it.id != supersededId && it.localPath == localPath && !it.finished }
