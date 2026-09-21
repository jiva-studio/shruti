import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"

export interface PlaylistCompletedTracksReturn {
  /**
   * Track ids the user has ever finished, over the union of active and
   * archived items.
   *
   * Deliberately the LIFETIME question, not the per-pass one the active page
   * asks: archiving leaves `listening_sessions` untouched, so the Library
   * badge survives both an archive and a re-add of the same row. Home shows
   * the current pass and is meant to disagree.
   */
  loadFor(activeItems: readonly PlaylistItem[]): Promise<ReadonlySet<string>>
}

export function usePlaylistCompletedTracks(): PlaylistCompletedTracksReturn {
  const app = useLectorium()

  async function loadFor(activeItems: readonly PlaylistItem[]): Promise<ReadonlySet<string>> {
    const repos = app.repositories()
    const archivedItems = await repos.playlistItems.listArchived()
    const items = [...activeItems, ...archivedItems]
    if (items.length === 0) return new Set<string>()
    const trackIds = [...new Set(items.map((i) => i.trackId))]
    const trackById = await repos.tracks.getByIds(trackIds)
    const everCompleted = await repos.listeningSessions.listEverCompletedItems(
      items.map((i) => i.id),
      collectDurationsSec(items, trackById)
    )
    const completed = new Set<string>()
    for (const item of items) {
      if (everCompleted.has(item.id)) completed.add(item.trackId)
    }
    return completed
  }

  return { loadFor }
}

function collectDurationsSec(
  items: readonly PlaylistItem[],
  trackById: ReadonlyMap<TrackId, Track>
): Map<PlaylistItemId, number> {
  const out = new Map<PlaylistItemId, number>()
  for (const item of items) {
    const track = trackById.get(item.trackId)
    if (!track) continue
    const ms = maxAudioDurationMs(track)
    if (ms > 0) out.set(item.id, Math.floor(ms / 1000))
  }
  return out
}
