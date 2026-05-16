import { onBeforeUnmount, onMounted, watch, type Ref } from "vue"
import { archivePlaylistItem } from "@lib/application/archivePlaylistItem.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"

/**
 * User-facing key for the auto-archive delay setting. Read by Settings
 * and by this composable so both stay in lockstep.
 */
export const AUTO_ARCHIVE_DELAY_KEY = "settings.autoArchiveDelay"

export type AutoArchiveDelay = "off" | "immediate" | "8h" | "1d" | "2d" | "3d"

const DAY_MS = 86_400_000

/**
 * Convert the user's chosen bucket into milliseconds. `"off"` is exposed
 * as `null` so callers can branch on a single nullish check rather than
 * a sentinel value.
 */
export function autoArchiveDelayMs(value: AutoArchiveDelay): number | null {
  switch (value) {
    case "off":
      return null
    case "immediate":
      return 0
    case "8h":
      return 8 * 3_600_000
    case "1d":
      return DAY_MS
    case "2d":
      return 2 * DAY_MS
    case "3d":
      return 3 * DAY_MS
  }
}

export interface AutoArchiveSweepDeps {
  listActive: () => Promise<readonly { id: PlaylistItemId; trackId: TrackId }[]>
  getTracks: (ids: readonly TrackId[]) => Promise<ReadonlyMap<TrackId, Track>>
  getCompletedAt: (
    itemIds: readonly PlaylistItemId[],
    durations: ReadonlyMap<PlaylistItemId, number>
  ) => Promise<ReadonlyMap<PlaylistItemId, number | null>>
  archive: (itemId: PlaylistItemId) => Promise<unknown>
  now: () => number
}

/**
 * Idempotent sweep: archive every active playlist item whose first
 * "completed" listening session is at least `delay` old. Pure reads on
 * the playlist + sessions repos plus one archive call per candidate;
 * safe to call repeatedly.
 *
 * Skips the DB round-trip when the setting is `"off"`.
 */
export async function runAutoArchiveSweep(
  delay: AutoArchiveDelay,
  deps: AutoArchiveSweepDeps
): Promise<readonly PlaylistItemId[]> {
  const delayMs = autoArchiveDelayMs(delay)
  if (delayMs === null) return []

  const items = await deps.listActive()
  if (items.length === 0) return []

  const trackIds = items.map((i) => i.trackId)
  const tracks = await deps.getTracks(trackIds)
  const durations = new Map<PlaylistItemId, number>()
  for (const it of items) {
    const track = tracks.get(it.trackId)
    if (!track) continue
    const ms = maxAudioDurationMs(track)
    if (ms > 0) durations.set(it.id, Math.floor(ms / 1000))
  }

  const itemIds = items.map((i) => i.id)
  const completedAtSec = await deps.getCompletedAt(itemIds, durations)
  const now = deps.now()
  const archived: PlaylistItemId[] = []
  for (const id of itemIds) {
    const sec = completedAtSec.get(id)
    if (sec === null || sec === undefined) continue
    if (now - sec * 1000 >= delayMs) {
      await deps.archive(id)
      archived.push(id)
    }
  }
  return archived
}

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
  const app = useLectorium()
  const playlist = usePlaylistStore()

  let running = false

  async function sweep(): Promise<void> {
    if (delay.value === "off") return
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
        archive: (itemId) =>
          archivePlaylistItem(
            { itemId },
            { playlistItems: repos.playlistItems, unitOfWork: repos.unitOfWork }
          ),
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
  // `1d → immediate`). Without this the previous completions sit until
  // the next fresh finish triggers the completion-watcher below.
  watch(delay, () => void sweep())

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
