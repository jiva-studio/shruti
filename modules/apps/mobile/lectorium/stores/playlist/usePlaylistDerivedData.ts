import { useLectorium } from "@lectorium/lectorium.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"

export interface DerivedData {
  /** Position in **milliseconds** for each loaded item, derived from sessions. */
  readonly progress: ReadonlyMap<PlaylistItemId, number>
  /** `ended_at` in **unix milliseconds** when the item was first finished, or null. */
  readonly completed: ReadonlyMap<PlaylistItemId, number | null>
}

export interface PlaylistDerivedDataReturn {
  /**
   * Resolve progress + completion for a set of playlist entries in a single
   * round-trip pair (`getProgressForItems` + `getCompletedAtForItems` in
   * parallel). Both are chunked, so the whole active list is a valid input.
   * Empty input short-circuits — no SQL is issued.
   */
  loadFor(pageEntries: readonly PlaylistEntry[]): Promise<DerivedData>
}

/**
 * Encapsulates the read-side of per-item progress and completion. The
 * playlist row no longer carries `progress` / `completed_at` columns;
 * they are derived from the `listening_sessions` journal on every page
 * load and kept in side-maps the playlist store exposes.
 *
 * Positions in the journal are stored as **seconds**; this composable
 * converts to **milliseconds** at the boundary so the rest of the app
 * (player, UI) doesn't have to worry about unit mismatches.
 */
export function usePlaylistDerivedData(): PlaylistDerivedDataReturn {
  const app = useLectorium()

  async function loadFor(pageEntries: readonly PlaylistEntry[]): Promise<DerivedData> {
    if (pageEntries.length === 0) {
      return { progress: new Map(), completed: new Map() }
    }
    const repos = app.repositories()
    const itemIds = pageEntries.map((e) => e.item.id)
    const durationsSec = new Map<PlaylistItemId, number>()
    for (const e of pageEntries) {
      const ms = maxAudioDurationMs(e.track)
      if (ms > 0) durationsSec.set(e.item.id, Math.floor(ms / 1000))
    }
    const [progressEntries, completedEntries] = await Promise.all([
      repos.listeningSessions.getProgressForItems(itemIds),
      repos.listeningSessions.getCompletedAtForItems(itemIds, durationsSec),
    ])
    const progress = new Map<PlaylistItemId, number>()
    for (const [id, entry] of progressEntries) {
      progress.set(id, entry.position * 1000)
    }
    const completed = new Map<PlaylistItemId, number | null>()
    for (const [id, sec] of completedEntries) {
      completed.set(id, sec === null ? null : sec * 1000)
    }
    return { progress, completed }
  }

  return { loadFor }
}
