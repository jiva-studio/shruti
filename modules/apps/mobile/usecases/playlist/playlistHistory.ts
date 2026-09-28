import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import type { PlaylistEntry } from "./listPlaylistTracks.js"

export interface PlaylistProgress {
  /** Position in **milliseconds** for each loaded item, derived from sessions. */
  readonly progress: ReadonlyMap<PlaylistItemId, number>
  /** `ended_at` in **unix milliseconds** when the item was first finished, or null. */
  readonly completed: ReadonlyMap<PlaylistItemId, number | null>
}

/**
 * Progress and completion for a set of playlist entries, in one parallel pair
 * of reads. The playlist row carries neither: both are derived from the
 * `listening_sessions` journal, which stores seconds — converted to
 * milliseconds here so the player and the UI never see the other unit. Both
 * reads are chunked, so the whole active list is a valid input; an empty one
 * issues no query.
 */
export async function loadPlaylistProgress(
  entries: readonly PlaylistEntry[],
  deps: { readonly listeningSessions: IListeningSessionRepository }
): Promise<PlaylistProgress> {
  if (entries.length === 0) return { progress: new Map(), completed: new Map() }
  const itemIds = entries.map((e) => e.item.id)
  const durationsSec = new Map<PlaylistItemId, number>()
  for (const e of entries) {
    const ms = maxAudioDurationMs(e.track)
    if (ms > 0) durationsSec.set(e.item.id, Math.floor(ms / 1000))
  }
  const [progressEntries, completedEntries] = await Promise.all([
    deps.listeningSessions.getProgressForItems(itemIds),
    deps.listeningSessions.getCompletedAtForItems(itemIds, durationsSec),
  ])
  const progress = new Map<PlaylistItemId, number>()
  for (const [id, entry] of progressEntries) progress.set(id, entry.position * 1000)
  const completed = new Map<PlaylistItemId, number | null>()
  for (const [id, sec] of completedEntries) completed.set(id, sec === null ? null : sec * 1000)
  return { progress, completed }
}

export interface EverCompletedDeps {
  readonly playlistItems: IPlaylistItemRepository
  readonly tracks: ITrackRepository
  readonly listeningSessions: IListeningSessionRepository
}

/**
 * Track ids the user has ever finished, over the union of active and archived
 * items.
 *
 * Deliberately the LIFETIME question, not the per-pass one the active page
 * asks: archiving leaves `listening_sessions` untouched, so the Library badge
 * survives both an archive and a re-add of the same row. Home shows the
 * current pass and is meant to disagree.
 */
export async function loadEverCompletedTrackIds(
  activeItems: readonly PlaylistItem[],
  deps: EverCompletedDeps
): Promise<ReadonlySet<string>> {
  const archivedItems = await deps.playlistItems.listArchived()
  const items = [...activeItems, ...archivedItems]
  if (items.length === 0) return new Set<string>()
  const trackIds = [...new Set(items.map((i) => i.trackId))]
  const trackById = await deps.tracks.getByIds(trackIds)
  const everCompleted = await deps.listeningSessions.listEverCompletedItems(
    items.map((i) => i.id),
    collectDurationsSec(items, trackById)
  )
  const completed = new Set<string>()
  for (const item of items) {
    if (everCompleted.has(item.id)) completed.add(item.trackId)
  }
  return completed
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
