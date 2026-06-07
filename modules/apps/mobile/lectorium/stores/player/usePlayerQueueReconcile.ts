import type { AudioQueueTransition } from "@ports/app/audioPlayer.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"

function msToSec(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.floor(ms / 1000)
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
 * Idempotency has two guards:
 *  - an in-memory `lastSeq` so a foreground `onItemTransition` push and a
 *    concurrent drain can't double-write within a session, and
 *  - the playlist's `completedAt` map, which is already set by the live
 *    `usePlayerSession.applyStatus` completion path for items finished in
 *    the foreground — so we don't journal those a second time.
 * Cross-restart dedup ultimately rests on native clearing acked events.
 */
export function usePlayerQueueReconcile(): PlayerQueueReconcileReturn {
  const app = useLectorium()
  let lastSeq = 0

  async function reconcileAndAck(events: readonly AudioQueueTransition[]): Promise<void> {
    if (events.length === 0) return
    const playlist = usePlaylistStore()
    const repo = app.repositories().listeningSessions
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    let top = lastSeq

    for (const e of sorted) {
      top = Math.max(top, e.seq)
      if (e.seq <= lastSeq) continue

      // Only a natural end means the item was completed; a lock-screen
      // skip or a playback error finished it part-way.
      const completed = e.reason === "auto"

      // Skip items the live foreground path already journaled (the
      // applyStatus completion branch sets completedAt). Background
      // completions have no completedAt yet, so they fall through.
      const alreadyDone = completed && playlist.getCompletedAt(e.finishedItemId) != null
      if (!alreadyDone) {
        try {
          const id = await repo.forceStart({
            itemId: e.finishedItemId,
            position: msToSec(e.fromPositionMs),
          })
          // `ended_at` ends up as "now" rather than the original `e.at` —
          // the repo stamps server-less wall-clock. Completion detection
          // uses to_position vs duration, which is correct; only the exact
          // completion timestamp is approximate for long-backgrounded play.
          await repo.finish(id, { position: msToSec(e.finishedAtMs) })
        } catch {
          // Best-effort: a failed journal write shouldn't block the ack —
          // losing one history row is better than reprocessing forever.
        }
        playlist.patchProgress(
          e.finishedItemId,
          completed ? e.durationMs : e.finishedAtMs,
          e.durationMs
        )
      }
    }

    lastSeq = top
    await app.audioPlayer.ackEvents(top).catch(() => {})
  }

  return { reconcileAndAck }
}
