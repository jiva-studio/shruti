import { ref, type Ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { nextProgressMs, reachesCompletion, resolvePlaybackDurationMs } from "./playlistProgress.js"

export interface PlaylistProgressMapReturn {
  /** Position in milliseconds per item, derived from `listening_sessions`. */
  readonly progressMap: Ref<ReadonlyMap<PlaylistItemId, number>>
  /** Unix milliseconds the item was first finished, or null. */
  readonly completedAtMap: Ref<ReadonlyMap<PlaylistItemId, number | null>>
  replaceAll(
    progress: ReadonlyMap<PlaylistItemId, number>,
    completed: ReadonlyMap<PlaylistItemId, number | null>
  ): void
  clear(): void
  /**
   * Patch progress (and completion, if reached) for one item. Pure UI sync —
   * the tracker has already written the journal.
   *
   * `durationMs` is the engine-reported duration, so completion still works for
   * items living past the first paged window, where no entry is loaded to read
   * a catalog duration from.
   *
   * `allowCompletion: false` patches position without completing — a
   * lock-screen skip or a playback error can land near the end, and must not
   * auto-archive an unfinished lecture.
   */
  patch(
    itemId: PlaylistItemId,
    progressMs: number,
    durationMs?: number,
    options?: { allowCompletion?: boolean }
  ): void
  progressMsOf(itemId: PlaylistItemId): number
  completedAtOf(itemId: PlaylistItemId): number | null
}

export function usePlaylistProgressMap(
  catalogDurationMsOf: (itemId: PlaylistItemId) => number
): PlaylistProgressMapReturn {
  const progressMap = ref<ReadonlyMap<PlaylistItemId, number>>(new Map())
  const completedAtMap = ref<ReadonlyMap<PlaylistItemId, number | null>>(new Map())

  function replaceAll(
    progress: ReadonlyMap<PlaylistItemId, number>,
    completed: ReadonlyMap<PlaylistItemId, number | null>
  ): void {
    progressMap.value = progress
    completedAtMap.value = completed
  }

  function clear(): void {
    replaceAll(new Map(), new Map())
  }

  function patch(
    itemId: PlaylistItemId,
    progressMs: number,
    durationMs?: number,
    options?: { allowCompletion?: boolean }
  ): void {
    const alreadyCompleted = completedAtMap.value.get(itemId) != null
    const current = progressMap.value.get(itemId) ?? 0
    const next = new Map(progressMap.value)
    next.set(itemId, nextProgressMs(current, progressMs, alreadyCompleted))
    progressMap.value = next

    if (options?.allowCompletion === false || alreadyCompleted) return
    const duration = resolvePlaybackDurationMs(catalogDurationMsOf(itemId), durationMs)
    if (!reachesCompletion(progressMs, duration)) return
    const nextCompleted = new Map(completedAtMap.value)
    nextCompleted.set(itemId, Date.now())
    completedAtMap.value = nextCompleted
  }

  function progressMsOf(itemId: PlaylistItemId): number {
    return progressMap.value.get(itemId) ?? 0
  }

  function completedAtOf(itemId: PlaylistItemId): number | null {
    return completedAtMap.value.get(itemId) ?? null
  }

  return { progressMap, completedAtMap, replaceAll, clear, patch, progressMsOf, completedAtOf }
}
