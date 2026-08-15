import { defineStore } from "pinia"
import { computed, ref } from "vue"
import {
  addTrackToPlaylist,
  type AddTrackToPlaylistError,
} from "@usecases/playlist/addTrackToPlaylist.js"
import {
  archivePlaylistItem,
  type ArchivePlaylistItemError,
} from "@usecases/playlist/archivePlaylistItem.js"
import { listActivePlaylistTracks } from "@usecases/playlist/listPlaylistTracks.js"
import { trackIdFromSyntheticItemId } from "@usecases/playback/playTrack.js"
import type { AuthorId, LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import { isCompleted } from "@lib/domain/listeningSession.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import { resolveTrackAuthorName } from "@lib/domain/services/trackAuthor.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import type { Result } from "@kit/core"
import type { AudioQueueItem } from "@ports/app/audioPlayer.js"
import { useShruti } from "@shruti/shruti.js"
import { releaseFromNativeQueue } from "@shruti/services/nativeQueue.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlaylistDerivedData } from "./playlist/usePlaylistDerivedData.js"
import { usePlaylistPrefetch } from "./playlist/usePlaylistPrefetch.js"

export interface PlaylistEntry {
  readonly item: PlaylistItem
  readonly track: Track
}

const PAGE_SIZE = 50

/**
 * Upper bound on the native playback queue handed over in one go. Each item
 * costs a `resolveLocalUrl` bridge round-trip at open time, so the tail is
 * capped — but it is capped on the *active list*, not on what Home happens to
 * have rendered.
 */
const QUEUE_SIZE = 50

/**
 * Single source of truth for the user's active playlist.
 *
 * HomeView renders from `entries`. SearchView pushes new tracks through
 * `add()` — the store owns the `addTrackToPlaylist` use-case + refresh,
 * so the Home list updates immediately without the views coordinating.
 *
 * Per-item progress / completion (loaded from `listening_sessions`) and
 * audio + transcript prefetch are delegated to two composables under
 * `stores/playlist/` to keep this store focused on queue state.
 */
export const usePlaylistStore = defineStore("playlist", () => {
  const app = useShruti()
  const derived = usePlaylistDerivedData()
  const prefetch = usePlaylistPrefetch()

  // The whole active playlist, hydrated. `entries` below is only the window
  // Home has rendered so far: the native queue and every by-id lookup outlive
  // that window, so they read from here instead.
  const activeEntries = ref<readonly PlaylistEntry[]>([])
  const entries = ref<readonly PlaylistEntry[]>([])
  const total = ref<number>(0)
  // All track ids in the active playlist, regardless of whether their
  // rows have been paged into `entries` yet. Backs hasTrack() so Search
  // shows the "added" indicator even for tracks past the first page.
  const activeTrackIds = ref<ReadonlySet<string>>(new Set())
  // Track ids that have ever been completed across the union of active +
  // archived playlist items. Backs hasCompletedTrack() so Search/Library
  // keeps the "listened" badge after a track is archived — archive only
  // removes the item from the active list, listening_sessions is untouched.
  const completedTrackIds = ref<ReadonlySet<string>>(new Set())
  const progressMap = ref<ReadonlyMap<PlaylistItemId, number>>(new Map())
  const completedAtMap = ref<ReadonlyMap<PlaylistItemId, number | null>>(new Map())
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  const hasMore = computed(() => entries.value.length < activeEntries.value.length)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const repos = app.repositories()
      const all = await listActivePlaylistTracks({
        playlistItems: repos.playlistItems,
        tracks: repos.tracks,
      })
      activeEntries.value = all.entries
      // Keep whatever the user has already paged in: refresh() also fires
      // mid-playback (auto-archive sweep, add, archive), and resetting the
      // list back to the first page under a scrolled Home is a jump.
      const rendered = Math.max(PAGE_SIZE, entries.value.length)
      entries.value = all.entries.slice(0, rendered)
      total.value = all.total
      // hasTrack() needs the full active list, not just the first page.
      const allItems = await repos.playlistItems.listActive()
      activeTrackIds.value = new Set(allItems.map((i) => i.trackId))
      // Derived data for the WHOLE active list, not the rendered window: the
      // Home "Up Next" badges count and sum the entire queue (#1850), so an
      // off-page item without a progress/completion entry would read as
      // unfinished with zero progress and inflate both numbers. Same precedent
      // as `listEverCompletedItems` below, which already walks the full
      // active-plus-archived union here.
      const next = await derived.loadFor(all.entries)
      progressMap.value = next.progress
      completedAtMap.value = next.completed
      // Union active + archived items, then ask the LIFETIME question —
      // deliberately not the per-pass one the active page uses. The archive
      // action sets `archived_at` but does NOT touch listening_sessions,
      // so we can still tell which tracks the user has finished — the
      // listened/completed badge has to survive archive (issue #470) AND a
      // re-add, which now resurrects the same row rather than minting a
      // fresh id (#1736). Home shows the current pass, Library the lifetime
      // badge; they are meant to disagree (SHRUTI-18/19).
      const archivedItems = await repos.playlistItems.listArchived()
      const allUnionItems = [...allItems, ...archivedItems]
      if (allUnionItems.length === 0) {
        completedTrackIds.value = new Set()
      } else {
        const unionTrackIds = [...new Set(allUnionItems.map((i) => i.trackId))]
        const trackById = await repos.tracks.getByIds(unionTrackIds)
        const durationsSec = new Map<PlaylistItemId, number>()
        for (const item of allUnionItems) {
          const t = trackById.get(item.trackId)
          if (!t) continue
          const ms = maxAudioDurationMs(t)
          if (ms > 0) durationsSec.set(item.id, Math.floor(ms / 1000))
        }
        const everCompleted = await repos.listeningSessions.listEverCompletedItems(
          allUnionItems.map((i) => i.id),
          durationsSec
        )
        const completedSet = new Set<string>()
        for (const item of allUnionItems) {
          if (everCompleted.has(item.id)) completedSet.add(item.trackId)
        }
        completedTrackIds.value = completedSet
      }
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
      activeEntries.value = []
      entries.value = []
      total.value = 0
      activeTrackIds.value = new Set()
      completedTrackIds.value = new Set()
      progressMap.value = new Map()
      completedAtMap.value = new Map()
    } finally {
      isLoading.value = false
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

  /**
   * Lazy refresh — only refetches if we've never loaded. Cheap to call
   * from every view's `onMounted`.
   */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  async function add(
    trackId: TrackId,
    collectionId: string | null = null
  ): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
    const repos = app.repositories()
    const result = await addTrackToPlaylist(
      { trackId, collectionId },
      { playlistItems: repos.playlistItems, unitOfWork: repos.unitOfWork }
    )
    if (result.ok) {
      // Synchronously claim "downloading" BEFORE refresh() so the row's
      // first paint after add-to-playlist already shows the spinner —
      // otherwise the mapper sees the freshly-inserted playlist entry
      // (state "added", green check) before prefetch's async path
      // gets around to setting the download flag. `markStartingDownload`
      // self-skips when the track is already cached.
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
    const repos = app.repositories()
    // Drop any pending prefetch for this track so we don't waste
    // bandwidth on a file the user is archiving. Mid-flight transfers
    // can't be aborted yet; this only covers the queued case (the
    // common one — auto-download queues many items deeper than the
    // user's reach).
    const entry = getEntryByItemId(itemId)
    if (entry) useDownloadStore().cancelPrefetch(entry.item.trackId)
    const result = await archivePlaylistItem(
      { itemId },
      { playlistItems: repos.playlistItems, unitOfWork: repos.unitOfWork }
    )
    if (result.ok || result.error === "already-archived") {
      requestSync()
      // Pull the lecture out of the live native queue BEFORE its audio goes:
      // the engine holds `file://` URLs resolved when the queue was built, and
      // advancing into a deleted one strands playback. `keepFile` comes back
      // true when the item can't be pulled out (it is playing right now) —
      // then the file has to stay.
      const keepFile = await releaseFromNativeQueue(itemId)
      if (options?.refresh ?? true) await refresh()
      // Archiving is the only way a lecture leaves the queue, so it's also
      // the only moment its audio stops being worth keeping. Reclaiming it
      // here is what lets a budget-capped queue keep downloading as the
      // user works through it. Best-effort: a failed delete just leaves the
      // file for the next pass. A kept file is the player's to reclaim once
      // the engine lets go (see `flushPendingEvictions`).
      if (entry && !keepFile) void useDownloadStore().evict(entry.item.trackId)
    }
    return result
  }

  async function archiveByTrackId(
    trackId: TrackId
  ): Promise<Result<void, ArchivePlaylistItemError> | null> {
    const target = getEntryByTrackId(trackId)
    if (!target) return null
    return archive(target.item.id)
  }

  function hasTrack(trackId: TrackId): boolean {
    return activeTrackIds.value.has(trackId)
  }

  /**
   * True if the user has ever completed a playlist item for this track,
   * regardless of whether it's still active or archived. Backs the
   * Library/Search "listened" badge so archiving doesn't drop the
   * indicator (issue #470).
   */
  function hasCompletedTrack(trackId: TrackId): boolean {
    return completedTrackIds.value.has(trackId)
  }

  /**
   * First entry whose track matches the given id, or `undefined`. Searches
   * the whole active playlist — a lecture opened from the Track screen or a
   * chat citation must resolve to its playlist item however deep it sits,
   * otherwise playback is journaled under a synthetic id no row carries.
   */
  function getEntryByTrackId(trackId: TrackId): PlaylistEntry | undefined {
    return activeEntries.value.find((e) => e.item.trackId === trackId)
  }

  /** Entry for a playlist item id, or `undefined`. Not bounded by the page. */
  function getEntryByItemId(itemId: PlaylistItemId): PlaylistEntry | undefined {
    return activeEntries.value.find((e) => e.item.id === itemId)
  }

  /**
   * The track behind a playback item id, wherever the id came from: the
   * active list, an item archived while it was still queued, or the
   * synthetic `track:<id>` a screen outside the playlist plays under. The
   * native queue outlives the list this store holds, so the player needs a
   * lookup that survives the item leaving it.
   */
  async function resolveTrackForItemId(itemId: PlaylistItemId): Promise<Track | undefined> {
    const entry = getEntryByItemId(itemId)
    if (entry) return entry.track
    const repos = app.repositories()
    const item = await repos.playlistItems.getById(itemId).catch(() => null)
    const trackId = item?.trackId ?? trackIdFromSyntheticItemId(itemId)
    if (!trackId) return undefined
    return (await repos.tracks.getById(trackId).catch(() => null)) ?? undefined
  }

  function pickVariant(track: Track, preferred?: LanguageCode): TrackVariant | undefined {
    if (preferred) {
      const v = track.variants.find((x) => x.language === preferred && x.audio)
      if (v) return v
    }
    return track.variants.find((v) => v.audio)
  }

  /**
   * Build the native playback queue starting at `fromItemId` — the tapped
   * track plus every following entry of the ACTIVE playlist, in order (no
   * skip/reorder; already-listened entries still play), capped at
   * {@link QUEUE_SIZE}. This is what enables continuous **background** playback:
   * the whole tail is handed to the native engine up front so it can
   * auto-advance while the JS layer is suspended.
   *
   * Each item's URL prefers the already-downloaded local file (resolved
   * without forcing a download — `prefetchAll` owns downloading) and
   * falls back to the public CDN URL for streaming when online. Entries
   * without audio are skipped.
   */
  async function buildQueueFrom(
    fromItemId: PlaylistItemId,
    preferredLanguage?: LanguageCode
  ): Promise<AudioQueueItem[]> {
    const startIdx = activeEntries.value.findIndex((e) => e.item.id === fromItemId)
    if (startIdx < 0) return []
    const slice = activeEntries.value.slice(startIdx, startIdx + QUEUE_SIZE)
    const authorCache = new Map<AuthorId, Author | null>()
    const repos = app.repositories()
    const out: AudioQueueItem[] = []
    for (const { item, track } of slice) {
      const variant = pickVariant(track, preferredLanguage)
      if (!variant?.audio) continue
      const path = variant.audio.path
      const probe = buildServerUrl(app.activeServer.value, path)
      const local = await app.mediaDownloader.resolveLocalUrl(probe).catch(() => null)
      const url = local ?? app.storagePublicUrl.get(path)
      let authorEntity: Author | null = null
      if (track.authorId) {
        if (!authorCache.has(track.authorId)) {
          authorCache.set(
            track.authorId,
            await repos.authors.getById(track.authorId).catch(() => null)
          )
        }
        authorEntity = authorCache.get(track.authorId) ?? null
      }
      // Resolve identically to the list rows (buildTrackRow) — including the
      // personal-library raw-author fallback — so the lock screen and the list
      // can't disagree on a track's author.
      const author = resolveTrackAuthorName(track, authorEntity, variant.language)
      out.push({
        itemId: item.id,
        url,
        title: variant.title,
        author,
        // audio.duration is already milliseconds (TrackAudio.duration), and the
        // queue item's durationMs is milliseconds too — pass it through, no ×1000.
        durationMs: variant.audio.duration ?? undefined,
      })
    }
    return out
  }

  /**
   * Patch the in-memory progress (and completion, if reached) for an
   * item. Called by the player on each session finalize. Pure UI sync —
   * no DB write here, since the DB is already up-to-date through the
   * tracker.
   *
   * `durationMs` is the engine-reported duration of the currently-loaded
   * track. It's used so we can still mark completion for items that live
   * past the first paged window (`entries`) — without it we'd need
   * `entry.track` to read the duration, and items off-page wouldn't be
   * eligible.
   *
   * `allowCompletion` (default true) lets a caller patch position WITHOUT
   * marking completion — e.g. a lock-screen skip or playback error that
   * finished a track part-way but happened to land near the end. The
   * reconcile path passes false for those so a non-natural end can't
   * falsely complete + auto-archive an unfinished lecture.
   */
  function patchProgress(
    itemId: PlaylistItemId,
    progressMs: number,
    durationMs?: number,
    options?: { allowCompletion?: boolean }
  ): void {
    const allowCompletion = options?.allowCompletion ?? true
    // Once an item is `completed`, the engine can still emit a late
    // `playing=false, position<duration` tick (it sometimes settles a
    // few hundred ms before the reported duration). Let it update the
    // journal via `tracker.finish`, but don't let the UI's progressMap
    // rewind — that would visually drop the radial back below 100%.
    const alreadyCompleted = completedAtMap.value.get(itemId) != null
    const current = progressMap.value.get(itemId) ?? 0
    const effective = alreadyCompleted ? Math.max(current, progressMs) : progressMs

    const next = new Map(progressMap.value)
    next.set(itemId, effective)
    progressMap.value = next

    // Prefer the engine-reported duration when present and positive: the
    // catalog duration (`maxAudioDurationMs`) can overstate a denoised /
    // re-encoded file that's actually shorter, so completion would never
    // trigger against the catalog value. Taking the min keeps completion
    // correct whichever source is shorter while still tolerating a stale
    // or missing engine duration.
    const catalogDurationMs = (() => {
      const entry = getEntryByItemId(itemId)
      return entry ? maxAudioDurationMs(entry.track) : 0
    })()
    const engineDurationMs = durationMs && durationMs > 0 ? durationMs : 0
    const resolvedDurationMs =
      catalogDurationMs > 0 && engineDurationMs > 0
        ? Math.min(catalogDurationMs, engineDurationMs)
        : engineDurationMs || catalogDurationMs

    if (
      allowCompletion &&
      resolvedDurationMs > 0 &&
      isCompleted(progressMs, resolvedDurationMs) &&
      completedAtMap.value.get(itemId) == null
    ) {
      const nextCompleted = new Map(completedAtMap.value)
      nextCompleted.set(itemId, Date.now())
      completedAtMap.value = nextCompleted
    }
  }

  function getProgressMs(itemId: PlaylistItemId): number {
    return progressMap.value.get(itemId) ?? 0
  }

  function getCompletedAt(itemId: PlaylistItemId): number | null {
    return completedAtMap.value.get(itemId) ?? null
  }

  /**
   * Pre-warm the head of the list on Home mount. Capped at one page: the
   * rendered window now survives `refresh()`, so a user who scrolled deep
   * would otherwise re-fan-out over hundreds of rows on every mount.
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
    progressMap,
    completedAtMap,
    completedTrackIds,
    refresh,
    loadMore,
    ensureLoaded,
    add,
    archive,
    archiveByTrackId,
    hasTrack,
    hasCompletedTrack,
    getEntryByTrackId,
    getEntryByItemId,
    resolveTrackForItemId,
    buildQueueFrom,
    getProgressMs,
    getCompletedAt,
    patchProgress,
    prefetchAll,
  }
})
