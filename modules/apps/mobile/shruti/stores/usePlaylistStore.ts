import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { AddTrackToPlaylistError } from "@usecases/playlist/addTrackToPlaylist.js"
import type { ArchivePlaylistItemError } from "@usecases/playlist/archivePlaylistItem.js"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import type { Result } from "@kit/core"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"
import { usePlaylistUseCases } from "@shruti/wiring/playlistUseCases.js"
import { releaseFromNativeQueue } from "@shruti/services/nativeQueue.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlaylistLookups } from "./playlist/usePlaylistLookups.js"
import { usePlaylistPrefetch } from "./playlist/usePlaylistPrefetch.js"
import { usePlaylistProgressMap } from "./playlist/usePlaylistProgressMap.js"
import { usePlaylistQueueBuilder } from "./playlist/usePlaylistQueueBuilder.js"

export interface PlaylistEntry {
  readonly item: PlaylistItem
  readonly track: Track
}

const PAGE_SIZE = 50

/**
 * Single source of truth for the user's active playlist.
 *
 * HomeView renders from `entries`. SearchView pushes new tracks through
 * `add()` — the store owns the `addTrackToPlaylist` use-case + refresh, so the
 * Home list updates immediately without the views coordinating.
 *
 * Per-item progress / completion, id lookups, the lifetime "ever listened"
 * set, prefetch and the native queue build are delegated to composables under
 * `stores/playlist/`.
 */
export const usePlaylistStore = defineStore("playlist", () => {
  const useCases = usePlaylistUseCases()

  // The whole active playlist, hydrated. `entries` below is only the window
  // Home has rendered so far: the native queue and every by-id lookup outlive
  // that window, so they read from here instead.
  const activeEntries = ref<readonly PlaylistEntry[]>([])
  const entries = ref<readonly PlaylistEntry[]>([])
  const total = ref<number>(0)
  /** Every active track id, page or no page — backs the Search "added" mark. */
  const activeTrackIds = ref<ReadonlySet<string>>(new Set())
  /** Track ids ever completed, active or archived — backs the "listened" badge. */
  const completedTrackIds = ref<ReadonlySet<string>>(new Set())
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  const prefetch = usePlaylistPrefetch()
  const queueBuilder = usePlaylistQueueBuilder()
  const lookups = usePlaylistLookups(activeEntries, useCases.resolveTrackForItem)
  const progress = usePlaylistProgressMap((itemId) => {
    const entry = lookups.getEntryByItemId(itemId)
    return entry ? maxAudioDurationMs(entry.track) : 0
  })

  const hasMore = computed(() => entries.value.length < activeEntries.value.length)

  /** Bumped by every `refresh()`. Calls settle in any order: only the latest writes the store
   *  and owns `isLoading`, all at once after every read; a failed read keeps the last good list. */
  let refreshGeneration = 0
  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration
    isLoading.value = true
    error.value = null
    try {
      const all = await useCases.listActiveTracks()
      const allItems = await useCases.listActiveItems()
      // Derived data for the WHOLE active list, not the rendered window: the
      // Home "Up Next" badges count and sum the entire queue, so an off-page
      // item without an entry would read as unfinished and inflate both.
      const next = await useCases.loadProgress(all.entries)
      const completed = await useCases.loadEverCompletedTrackIds(allItems)
      if (generation !== refreshGeneration) return
      activeEntries.value = all.entries
      // Keep whatever the user has already paged in: refresh() also fires
      // mid-playback (auto-archive sweep, add, archive), and resetting the
      // list back to the first page under a scrolled Home is a jump.
      const rendered = Math.max(PAGE_SIZE, entries.value.length)
      entries.value = all.entries.slice(0, rendered)
      total.value = all.total
      activeTrackIds.value = new Set(allItems.map((i) => i.trackId))
      progress.replaceAll(next.progress, next.completed)
      completedTrackIds.value = completed
      loaded = true
    } catch (err) {
      if (generation !== refreshGeneration) return
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
    } finally {
      if (generation === refreshGeneration) isLoading.value = false
    }
  }

  /**
   * Widen the rendered window over the already-loaded active list. No derived
   * fetch: `refresh()` already loaded progress + completion for every active
   * item, so paging in a row has nothing left to look up.
   */
  function loadMore(): Promise<void> {
    if (!hasMore.value || isLoading.value) return Promise.resolve()
    const from = entries.value.length
    entries.value = [...entries.value, ...activeEntries.value.slice(from, from + PAGE_SIZE)]
    return Promise.resolve()
  }

  /** Lazy refresh — cheap to call from every view's `onMounted`. */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  async function add(
    trackId: TrackId,
    collectionId: string | null = null
  ): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
    const result = await useCases.add({ trackId, collectionId })
    if (result.ok) {
      // Claim "downloading" synchronously, BEFORE refresh(), so the row's first
      // paint already shows the spinner instead of the green check the mapper
      // would derive from the freshly-inserted entry. Self-skips when cached.
      useDownloadStore().markStartingDownload(trackId)
      requestSync()
      await refresh()
      void prefetch.prefetchTrack(trackId)
    }
    return result
  }

  /**
   * The single way a lecture leaves the active playlist — for a swipe on Home
   * and for the auto-archive sweep alike. It owns the whole teardown: the
   * pending prefetch, the live native queue, and the cached audio.
   *
   * `refresh: false` lets a batch caller (the sweep) archive many items and
   * re-hydrate once at the end instead of once per item.
   */
  async function archive(
    itemId: PlaylistItemId,
    options?: { refresh?: boolean }
  ): Promise<Result<void, ArchivePlaylistItemError>> {
    // Mid-flight transfers can't be aborted yet; this covers the queued case,
    // which is the common one (auto-download runs far ahead of the user).
    const entry = lookups.getEntryByItemId(itemId)
    if (entry) useDownloadStore().cancelPrefetch(entry.item.trackId)
    const result = await useCases.archive(itemId)
    if (result.ok || result.error === "already-archived") {
      requestSync()
      // Pull the lecture out of the live native queue BEFORE its audio goes:
      // the engine holds `file://` URLs resolved when the queue was built, and
      // advancing into a deleted one strands playback. `keepFile` comes back
      // true when it can't be pulled out (it is playing right now).
      const keepFile = await releaseFromNativeQueue(itemId)
      if (options?.refresh ?? true) await refresh()
      // Archiving is the only moment a lecture's audio stops being worth
      // keeping, which is what lets a budget-capped queue keep downloading.
      // Best-effort; a kept file is the player's to reclaim once the engine
      // lets go (see `flushPendingEvictions`).
      if (entry && !keepFile) void useDownloadStore().evict(entry.item.trackId)
    }
    return result
  }

  async function archiveByTrackId(
    trackId: TrackId
  ): Promise<Result<void, ArchivePlaylistItemError> | null> {
    const target = lookups.getEntryByTrackId(trackId)
    if (!target) return null
    return archive(target.item.id)
  }

  function hasTrack(trackId: TrackId): boolean {
    return activeTrackIds.value.has(trackId)
  }

  /** True if the user has ever completed an item for this track, active or not. */
  function hasCompletedTrack(trackId: TrackId): boolean {
    return completedTrackIds.value.has(trackId)
  }

  function buildQueueFrom(
    fromItemId: PlaylistItemId,
    preferredLanguage?: LanguageCode
  ): Promise<AudioQueueItem[]> {
    return queueBuilder.buildFrom(activeEntries.value, fromItemId, preferredLanguage)
  }

  /**
   * Pre-warm the head of the list on Home mount. Capped at one page: the
   * rendered window survives `refresh()`, so a user who scrolled deep would
   * otherwise re-fan-out over hundreds of rows on every mount.
   */
  function prefetchAll(): void {
    prefetch.prefetchAll(entries.value.slice(0, PAGE_SIZE))
  }

  return {
    entries,
    activeEntries,
    total,
    hasMore,
    isLoading,
    error,
    progressMap: progress.progressMap,
    completedAtMap: progress.completedAtMap,
    completedTrackIds,
    refresh,
    loadMore,
    ensureLoaded,
    add,
    archive,
    archiveByTrackId,
    hasTrack,
    hasCompletedTrack,
    getEntryByTrackId: lookups.getEntryByTrackId,
    getEntryByItemId: lookups.getEntryByItemId,
    resolveTrackForItemId: lookups.resolveTrackForItemId,
    buildQueueFrom,
    getProgressMs: progress.progressMsOf,
    getCompletedAt: progress.completedAtOf,
    patchProgress: progress.patch,
    prefetchAll,
  }
})
