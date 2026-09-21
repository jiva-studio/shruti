import { onBeforeUnmount, onMounted, watch, type Ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { AUTO_DOWNLOAD_TARGET_SECONDS_KEY } from "@lectorium/composables/useAutoDownloadLoop.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import {
  AUTO_ARCHIVE_DELAY_KEY,
  isAutoArchiveActive,
  runAutoArchiveSweep,
  type AutoArchiveDelay,
} from "@lectorium/composables/autoArchiveSweep.js"

export {
  AUTO_ARCHIVE_DELAY_KEY,
  AUTO_ARCHIVE_LAST_DELAY_KEY,
  autoArchiveDelayMs,
  isAutoArchiveActive,
  runAutoArchiveSweep,
  type AutoArchiveDelay,
  type AutoArchiveSweepDeps,
} from "@lectorium/composables/autoArchiveSweep.js"

/**
 * Wires {@link runAutoArchiveSweep} into the app lifecycle:
 *
 *  - On mount (app bootstrap) — sweeps stale completions from previous
 *    sessions.
 *  - Whenever the playlist store records a fresh completion — schedules
 *    another sweep so the "immediate" option actually archives within
 *    seconds and longer delays still re-evaluate on each new finish.
 *
 * Errors are swallowed (and logged) — a failed sweep should never crash
 * the host view; the next mount/completion will retry.
 */
export function useAutoArchiveSweep(): {
  delay: Ref<AutoArchiveDelay>
  sweep: () => Promise<void>
} {
  const delay = useConfig<AutoArchiveDelay>(AUTO_ARCHIVE_DELAY_KEY, "off")
  const targetSeconds = useConfig<number>(AUTO_DOWNLOAD_TARGET_SECONDS_KEY, 0)
  const app = useLectorium()
  const playlist = usePlaylistStore()
  const purchases = usePurchasesStore()

  let running = false

  async function sweep(): Promise<void> {
    if (!purchases.isSubscribed) return
    if (!isAutoArchiveActive(delay.value, targetSeconds.value)) return
    if (running) return
    running = true
    try {
      // `app.repositories()` throws before the user/content DBs are open
      // (App.vue mounts well before the welcome flow opens them).
      // Suppress the boot-time miss — the playlist watcher below will
      // re-trigger as soon as the first `refresh()` populates the maps.
      const repos = (() => {
        try {
          return app.repositories()
        } catch {
          return null
        }
      })()
      if (repos === null) return
      const archived = await runAutoArchiveSweep(delay.value, {
        listActive: () => repos.playlistItems.listActive(),
        getTracks: (ids) => repos.tracks.getByIds(ids),
        getCompletedAt: (itemIds, durations) =>
          repos.listeningSessions.getCompletedAtForItems(itemIds, durations),
        // Through the store, not the use case: it is the only place that
        // knows to pull the lecture out of the live native queue before its
        // audio goes. Re-hydration is deferred to the single refresh below.
        archive: (itemId) => playlist.archive(itemId, { refresh: false }),
        now: () => Date.now(),
      })
      if (archived.length > 0) {
        // Refresh so the Home list drops the archived rows without
        // waiting for the next manual navigation.
        await playlist.refresh()
      }
    } catch (err) {
      console.error("[auto-archive] sweep failed:", err)
    } finally {
      running = false
    }
  }

  onMounted(() => {
    // Best-effort first sweep — if DBs aren't open yet, the playlist
    // watcher below will catch the first real refresh.
    void Promise.resolve().then(sweep)
  })

  // Re-sweep when the user flips the delay (e.g. `off → immediate` or
  // `1d → immediate`). Without this the previous completions sit until the
  // next fresh finish triggers the completion-watcher below.
  watch(delay, () => void sweep())

  // The queue length is the OTHER half of the feature and says nothing about
  // archiving, so moving between two presets must not delete anything (#1663).
  // Only the master switch coming back on re-sweeps — that lifts the gate in
  // `isAutoArchiveActive`, and the backlog behind it is what needs the pass.
  watch(targetSeconds, (next, previous) => {
    if (next > 0 && previous <= 0) void sweep()
  })

  // Run a sweep right after the user subscribes (they may have a backlog
  // of long-finished items waiting for the gate to lift).
  watch(
    () => purchases.isSubscribed,
    (subscribed) => {
      if (subscribed) void sweep()
    }
  )

  // React to fresh completions. We snapshot the previous key set so the
  // sweep only fires when an item flips from `not-completed` to
  // `completed`, not on every page-in that brings new keys to the map.
  let previousCompletedIds = new Set<PlaylistItemId>()
  // Trailing-edge debounce: a burst of completions queues one sweep,
  // not N. The pending timer is cleared on each new completion so
  // bursts collapse to a single delayed sweep.
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => playlist.completedAtMap,
    (next) => {
      const newlyCompleted: PlaylistItemId[] = []
      const updated = new Set<PlaylistItemId>(previousCompletedIds)
      for (const [id, value] of next) {
        if (value === null || value === undefined) continue
        if (!previousCompletedIds.has(id)) newlyCompleted.push(id)
        updated.add(id)
      }
      previousCompletedIds = updated
      if (newlyCompleted.length === 0) return
      // Short debounce so the "completed" badge gets a moment to render
      // before the row disappears under the "immediate" setting.
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        void sweep()
      }, 750)
    },
    { deep: true }
  )

  onBeforeUnmount(() => {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  })

  return { delay, sweep }
}
