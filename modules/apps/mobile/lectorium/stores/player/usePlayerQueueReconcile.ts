import type { AudioQueueTransition } from "@ports/app/audioPlayer.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"

/** Device-local watermark: the highest native `seq` already folded in. */
const LAST_SEQ_KEY = "player.queue.lastSeq"

function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 1000)
}

/**
 * Durable identity of one native transition. All three components are assigned
 * once, natively, and re-presented verbatim on every replay of the journal, so
 * the same transition always yields the same key while two genuine transitions
 * (even two lock-screen taps on the same item) differ in `seq` and `at`.
 */
function sourceKey(e: AudioQueueTransition): string {
  return `queue:${e.seq}:${e.finishedItemId}:${e.at}`
}

export interface PlayerQueueReconcileReturn {
  /**
   * Fold the native transition journal into `listening_sessions` + the
   * playlist progress map, then ack the consumed range so native clears
   * it. Idempotent across calls and across app restarts.
   */
  reconcileAndAck(events: readonly AudioQueueTransition[]): Promise<void>
}

/**
 * Drains the native queue's durable transition journal into the app's
 * listening history. This is THE reconciliation path for items that
 * played (and finished) while the WebView JS was suspended in the
 * background — the native engine auto-advanced the queue and logged each
 * transition; here we replay that log on the next foreground tick / app
 * start.
 *
 * The journal survives the writes — only `ackEvents` removes an entry — so an
 * un-acked batch (bridge torn down, process killed) IS re-presented on the next
 * launch, and folding it in twice would count the same minutes twice. Three
 * guards, outermost first:
 *
 *  - a `seq` watermark PERSISTED in preferences, so it survives the process
 *    that wrote it (as a closure variable it reset to 0 every launch, which is
 *    exactly the killed-in-background case this path exists for);
 *  - a durable per-transition {@link sourceKey} on the session row, unique by
 *    schema (migration 025). This is the guarantee, and the only guard that
 *    covers `skip-next` / `skip-prev` / `error`: those finish an item part-way,
 *    so the completion guard below never applies to them;
 *  - the playlist's `completedAt` map, which suppresses an `auto` transition
 *    for an item the live `usePlayerSession.applyStatus` path already journaled
 *    in the foreground. It is a foreground-echo filter, not a replay guard: the
 *    map is empty on a cold start, drops completed items once auto-archive
 *    moves them, and only covers the first page of active items.
 *
 * Ordering is write → persist watermark → ack. Acking first would make a failed
 * write a silently lost session; this way the batch is retried and the source
 * keys make the retry free.
 */
export function usePlayerQueueReconcile(): PlayerQueueReconcileReturn {
  const app = useLectorium()
  /** In-memory echo of the persisted watermark; `null` until first read. */
  let lastSeq: number | null = null

  async function loadLastSeq(): Promise<number> {
    if (lastSeq !== null) return lastSeq
    const stored = await app.preferences.get(LAST_SEQ_KEY).catch(() => null)
    const parsed = stored === null ? Number.NaN : Number(stored)
    lastSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    return lastSeq
  }

  async function reconcileAndAck(events: readonly AudioQueueTransition[]): Promise<void> {
    if (events.length === 0) return
    const playlist = usePlaylistStore()
    const repo = app.repositories().listeningSessions
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    const stored = await loadLastSeq()
    // A reinstall / cleared app storage restarts the native counter at 1 while
    // our watermark stays high, which would drop every future event on the
    // floor. An un-acked replay always re-presents its own top seq, so a batch
    // that peaks BELOW the watermark can only be that regression: rewind, and
    // let the per-transition source keys do the deduping.
    const seen = sorted[sorted.length - 1]!.seq < stored ? 0 : stored
    // Seeded from `seen`, NOT `stored`: after a rewind a watermark left at the
    // old high would ack a range native never drained and would never come back
    // down, repeating for the life of the install (#1597).
    let top = seen

    for (const e of sorted) {
      top = Math.max(top, e.seq)
      if (e.seq <= seen) continue

      // Only a natural end means the item was completed; a lock-screen
      // skip or a playback error finished it part-way.
      const completed = e.reason === "auto"

      // Skip items the live foreground path already journaled (the
      // applyStatus completion branch sets completedAt). Background
      // completions have no completedAt yet, so they fall through.
      const alreadyDone = completed && playlist.getCompletedAt(e.finishedItemId) != null
      if (alreadyDone) continue

      // False only for a transition whose session is already on disk — a
      // replay. A write that THROWS still patches progress below, as before:
      // losing one history row shouldn't also lose the resume position.
      let firstTime = true
      try {
        const id = await repo.forceStartOnce({
          itemId: e.finishedItemId,
          position: msToSec(e.fromPositionMs),
          sourceKey: sourceKey(e),
        })
        if (id === null) firstTime = false
        // `ended_at` ends up as "now" rather than the original `e.at` —
        // the repo stamps server-less wall-clock. Completion detection
        // uses to_position vs duration, which is correct; only the exact
        // completion timestamp is approximate for long-backgrounded play.
        else await repo.finish(id, { position: msToSec(e.finishedAtMs) })
      } catch (err) {
        // Best-effort: a failed journal write shouldn't block the ack —
        // losing one history row is better than reprocessing forever.
        reportError("player-queue", err)
      }
      if (!firstTime) continue

      // A non-natural end (lock-screen skip / playback error) finished
      // the item part-way. Even if that part-way position lands within
      // COMPLETION_THRESHOLD_MS of the end, it must NOT mark completion
      // (which would auto-archive an unfinished lecture) — suppress it
      // via `allowCompletion: false`. Only `reason === "auto"` completes.
      playlist.patchProgress(
        e.finishedItemId,
        completed ? e.durationMs : e.finishedAtMs,
        e.durationMs,
        { allowCompletion: completed }
      )
    }

    lastSeq = top
    // Persisted BEFORE the ack, and reported when it fails: the ack is what
    // makes native forget, so a watermark lost between the two is what turns
    // the next launch into a replay.
    await app.preferences
      .set(LAST_SEQ_KEY, String(top))
      .catch((err: unknown) => reportError("player-queue", err))
    await app.audioPlayer.ackEvents(top).catch((err: unknown) => reportError("player-queue", err))
  }

  return { reconcileAndAck }
}
