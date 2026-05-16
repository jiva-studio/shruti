import { computed, onMounted, watch } from "vue"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAutoDownloadFiltersStore } from "@lectorium/stores/useAutoDownloadFiltersStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { durationFilterBounds } from "@lib/domain/durationFilters.js"
import type { TrackListFilters } from "@lib/domain/ports/trackRepository.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"

const MAX_ATTEMPTS_PER_RUN = 50
const PAGE_SIZE = 50

/**
 * Best-effort background loop that keeps a configurable amount of
 * unlistened audio queued in the active playlist. Driven by the
 * `settings.autoDownloadTargetSeconds` config — 0 disables the
 * feature entirely.
 *
 * Each run walks the library in default order and adds the first
 * track that isn't already in the active playlist or archived. Once
 * `queueDurationSec()` reaches the configured target, the loop
 * stops until something changes (a track completes, the user
 * archives, the target setting changes).
 *
 * Re-uses `playlist.add()` which already triggers the audio
 * prefetch via the download queue (#474). Failures don't break the
 * loop — the next iteration just tries the next candidate.
 */
export function useAutoDownloadLoop(): { targetSeconds: ReturnType<typeof useConfig<number>> } {
  const app = useLectorium()
  const playlist = usePlaylistStore()
  const filtersStore = useAutoDownloadFiltersStore()
  const purchases = usePurchasesStore()
  const targetSeconds = useConfig<number>("settings.autoDownloadTargetSeconds", 0)
  let running = false

  function currentFilters(): TrackListFilters {
    const duration = filtersStore.duration[0]
      ? durationFilterBounds(filtersStore.duration[0])
      : undefined
    return {
      authorIds: filtersStore.authorIds,
      locationIds: filtersStore.locationIds,
      languageCodes: filtersStore.languageCodes,
      sourceIds: filtersStore.sourceIds,
      tagIds: filtersStore.tagIds,
      durationMinMs: duration?.minMs,
      durationMaxMs: duration?.maxMs,
    }
  }

  function queueDurationSec(): number {
    let total = 0
    for (const entry of playlist.entries) {
      if (playlist.getCompletedAt(entry.item.id) !== null) continue
      const durMs = maxAudioDurationMs(entry.track)
      if (durMs <= 0) continue
      const progressMs = playlist.getProgressMs(entry.item.id)
      total += Math.max(0, Math.floor((durMs - progressMs) / 1000))
    }
    return total
  }

  async function refill(): Promise<void> {
    if (running) return
    if (!purchases.isSubscribed) return
    const target = targetSeconds.value
    if (target <= 0) return
    if (queueDurationSec() >= target) return
    running = true
    try {
      const repos = app.repositories()
      // Snapshot active + archived once per run; we re-check the
      // skip set after each successful add so the same track isn't
      // re-picked from a stale view.
      const activeItems = await repos.playlistItems.listActive()
      const archivedItems = await repos.playlistItems.listArchived()
      const skipIds = new Set<string>()
      for (const i of activeItems) skipIds.add(i.trackId)
      for (const i of archivedItems) skipIds.add(i.trackId)

      const filters = currentFilters()
      const sortBy = filtersStore.sort
      let pageOffset = 0
      for (let attempts = 0; attempts < MAX_ATTEMPTS_PER_RUN; attempts++) {
        if (queueDurationSec() >= target) return
        const page = await repos.tracks.list({
          filters,
          sortBy,
          limit: PAGE_SIZE,
          offset: pageOffset,
        })
        if (page.length === 0) return // exhausted the library
        const next = page.find((t) => !skipIds.has(t.id))
        if (!next) {
          pageOffset += PAGE_SIZE
          continue
        }
        skipIds.add(next.id)
        const result = await playlist.add(next.id)
        if (!result.ok && result.error !== "already-in-playlist") {
          // Don't loop on a backend error — bail; the next external
          // event (toggle, completion) will retry.
          return
        }
      }
    } catch (err) {
      console.error("[auto-download] refill failed:", err)
    } finally {
      running = false
    }
  }

  onMounted(() => {
    // Hydrate the filter snapshot before the first refill so the very
    // first page request reflects the user's selection instead of
    // hitting the library unfiltered for one cycle.
    void filtersStore.load().then(refill)
  })

  // Trigger refill on discrete events instead of a deep watch over
  // `progressMap` (which fires on every player tick — ~1 Hz during
  // playback). The conditions that actually change "should we add more?"
  // are: the target moved, a track was added/archived, or a track flipped
  // completed. Progress ticks alone don't enqueue: the next completion
  // event will shrink the queue and re-trigger.
  const completedCount = computed(() => {
    let n = 0
    for (const value of playlist.completedAtMap.values()) {
      if (value !== null && value !== undefined) n++
    }
    return n
  })

  // Re-fetch when the user edits the filter selection so the loop
  // picks up new criteria immediately (and drops candidates that no
  // longer match on the next refill cycle).
  const filtersFingerprint = computed(() =>
    JSON.stringify({
      a: filtersStore.authorIds,
      l: filtersStore.locationIds,
      lc: filtersStore.languageCodes,
      s: filtersStore.sourceIds,
      t: filtersStore.tagIds,
      d: filtersStore.duration,
      so: filtersStore.sort ?? "",
    })
  )

  watch(
    [
      targetSeconds,
      () => playlist.entries.length,
      completedCount,
      filtersFingerprint,
      () => purchases.isSubscribed,
    ],
    () => {
      void refill()
    }
  )

  return { targetSeconds }
}
