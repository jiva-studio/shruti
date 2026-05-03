import { defineStore } from "pinia"
import { computed, ref } from "vue"
import {
  addTrackToPlaylist,
  type AddTrackToPlaylistError,
} from "@lib/application/addTrackToPlaylist.js"
import {
  archivePlaylistItem,
  type ArchivePlaylistItemError,
} from "@lib/application/archivePlaylistItem.js"
import { listActivePlaylistTracks } from "@lib/application/listPlaylistTracks.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@lib/domain/result.js"
import { useShruti } from "@shruti/shruti.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { maxAudioDurationMs } from "@shruti/composables/trackDuration.js"

export interface PlaylistEntry {
  readonly item: PlaylistItem
  readonly track: Track
}

const PAGE_SIZE = 50

/**
 * Single source of truth for the user's active playlist.
 *
 * HomeView renders from `entries`. SearchView pushes new tracks through
 * `add()` — the store owns the `addTrackToPlaylist` use-case + refresh,
 * so the Home list updates immediately without the views coordinating.
 *
 * Per-item progress and completion are kept in side-maps populated from
 * `listening_sessions` on `refresh()` / `loadMore()`. The player calls
 * `patchProgress` on each session finalize so the playlist UI reflects
 * the latest position without a full refresh.
 */
export const usePlaylistStore = defineStore("playlist", () => {
  const app = useShruti()

  const entries = ref<readonly PlaylistEntry[]>([])
  const total = ref<number>(0)
  // All track ids in the active playlist, regardless of whether their
  // rows have been paged into `entries` yet. Backs hasTrack() so Search
  // shows the "added" indicator even for tracks past the first page.
  const activeTrackIds = ref<ReadonlySet<string>>(new Set())
  /** Position in milliseconds for each loaded item, derived from sessions. */
  const progressMap = ref<ReadonlyMap<PlaylistItemId, number>>(new Map())
  /** `ended_at` in unix ms when the item was first finished, or null. */
  const completedAtMap = ref<ReadonlyMap<PlaylistItemId, number | null>>(new Map())
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  const hasMore = computed(() => entries.value.length < total.value)

  async function loadDerivedFor(pageEntries: readonly PlaylistEntry[]): Promise<{
    progress: Map<PlaylistItemId, number>
    completed: Map<PlaylistItemId, number | null>
  }> {
    const repos = app.repositories()
    const itemIds = pageEntries.map((e) => e.item.id)
    if (itemIds.length === 0) {
      return { progress: new Map(), completed: new Map() }
    }
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

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const repos = app.repositories()
      const page = await listActivePlaylistTracks(
        { playlistItems: repos.playlistItems, tracks: repos.tracks },
        { limit: PAGE_SIZE, offset: 0 }
      )
      entries.value = page.entries
      total.value = page.total
      // hasTrack() needs the full active list, not just the first page.
      const allItems = await repos.playlistItems.listActive()
      activeTrackIds.value = new Set(allItems.map((i) => i.trackId))
      const derived = await loadDerivedFor(page.entries)
      progressMap.value = derived.progress
      completedAtMap.value = derived.completed
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
      entries.value = []
      total.value = 0
      activeTrackIds.value = new Set()
      progressMap.value = new Map()
      completedAtMap.value = new Map()
    } finally {
      isLoading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || isLoading.value) return
    try {
      const repos = app.repositories()
      const page = await listActivePlaylistTracks(
        { playlistItems: repos.playlistItems, tracks: repos.tracks },
        { limit: PAGE_SIZE, offset: entries.value.length }
      )
      entries.value = [...entries.value, ...page.entries]
      total.value = page.total
      const derived = await loadDerivedFor(page.entries)
      const nextProgress = new Map(progressMap.value)
      for (const [k, v] of derived.progress) nextProgress.set(k, v)
      progressMap.value = nextProgress
      const nextCompleted = new Map(completedAtMap.value)
      for (const [k, v] of derived.completed) nextCompleted.set(k, v)
      completedAtMap.value = nextCompleted
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
    }
  }

  /**
   * Lazy refresh — only refetches if we've never loaded. Cheap to call
   * from every view's `onMounted`.
   */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  async function add(trackId: TrackId): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
    const repos = app.repositories()
    const result = await addTrackToPlaylist(
      { trackId },
      { playlistItems: repos.playlistItems, unitOfWork: repos.unitOfWork }
    )
    if (result.ok) {
      await refresh()
      void prefetchAudio(trackId)
    }
    return result
  }

  // Fire-and-forget audio prefetch. The download indicator on the Home
  // row drives itself off the download store — the user sees progress
  // without the playlist view blocking on the network round-trip.
  async function prefetchAudio(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const track = await repos.tracks.getById(trackId)
      const variant = track?.variants.find((v) => v.audio) ?? null
      if (!variant?.audio) return
      useDownloadStore().prefetch(trackId, variant.audio.path)
    } catch (err) {
      console.error("[playlist] prefetch failed", err)
    }
    void prefetchTranscripts(trackId)
  }

  // Pull every advertised transcript into the on-disk cache so the
  // Transcript dialog renders instantly (and works offline) when the
  // user opens it later. Errors are swallowed — a missing transcript
  // is not fatal and the dialog has its own empty/error state.
  async function prefetchTranscripts(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const languages = await repos.transcripts.availableLanguages(trackId)
      for (const lang of languages) {
        repos.transcripts.get(trackId, lang).catch(() => {})
      }
    } catch (err) {
      console.error("[playlist] transcript prefetch failed", err)
    }
  }

  /** Prefetch audio + transcripts for every currently-loaded entry. Fire-and-forget. */
  function prefetchAll(): void {
    const downloads = useDownloadStore()
    for (const { track } of entries.value) {
      const variant = track.variants.find((v) => v.audio)
      if (variant?.audio) {
        downloads.prefetch(track.id, variant.audio.path)
      }
      void prefetchTranscripts(track.id)
    }
  }

  async function archive(itemId: PlaylistItemId): Promise<Result<void, ArchivePlaylistItemError>> {
    const repos = app.repositories()
    const result = await archivePlaylistItem(
      { itemId },
      { playlistItems: repos.playlistItems, unitOfWork: repos.unitOfWork }
    )
    if (result.ok || result.error === "already-archived") await refresh()
    return result
  }

  async function archiveByTrackId(
    trackId: TrackId
  ): Promise<Result<void, ArchivePlaylistItemError> | null> {
    const target = entries.value.find((e) => e.item.trackId === trackId)
    if (!target) return null
    return archive(target.item.id)
  }

  function hasTrack(trackId: TrackId): boolean {
    return activeTrackIds.value.has(trackId)
  }

  /** First entry whose track matches the given id, or `undefined`. */
  function getEntryByTrackId(trackId: TrackId): PlaylistEntry | undefined {
    return entries.value.find((e) => e.item.trackId === trackId)
  }

  /**
   * Patch the in-memory progress (and completion, if reached) for an
   * item. Called by the player on each session finalize. Pure UI sync —
   * no DB write here, since the DB is already up-to-date through the
   * tracker.
   */
  function patchProgress(itemId: PlaylistItemId, progressMs: number): void {
    const next = new Map(progressMap.value)
    next.set(itemId, progressMs)
    progressMap.value = next

    const entry = entries.value.find((e) => e.item.id === itemId)
    if (entry) {
      const durationMs = maxAudioDurationMs(entry.track)
      if (durationMs > 0 && progressMs >= durationMs - 2000) {
        if (completedAtMap.value.get(itemId) == null) {
          const nextCompleted = new Map(completedAtMap.value)
          nextCompleted.set(itemId, Date.now())
          completedAtMap.value = nextCompleted
        }
      }
    }
  }

  function getProgressMs(itemId: PlaylistItemId): number {
    return progressMap.value.get(itemId) ?? 0
  }

  function getCompletedAt(itemId: PlaylistItemId): number | null {
    return completedAtMap.value.get(itemId) ?? null
  }

  return {
    entries,
    total,
    hasMore,
    isLoading,
    error,
    progressMap,
    completedAtMap,
    refresh,
    loadMore,
    ensureLoaded,
    add,
    archive,
    archiveByTrackId,
    hasTrack,
    getEntryByTrackId,
    getProgressMs,
    getCompletedAt,
    patchProgress,
    prefetchAll,
  }
})
