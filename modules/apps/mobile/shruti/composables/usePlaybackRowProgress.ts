import { computed, reactive, type Ref } from "vue"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { UiTrackState } from "@ui/components/tracks/list/index.js"
import type { UiPlaybackProgress } from "@ui/features/playlist/index.js"

/**
 * Live playback state of the track the player is on, as ONE stable object with
 * per-field reactivity — the counterpart to `useTrackUiStateMapper`, which
 * builds rows without ever reading the playback position.
 *
 * Track lists used to fold the position into every row, so the one playing row
 * dirtied the whole list computed at the progress cadence (1 Hz foreground) and
 * all 50 rows were rebuilt per tick, off-screen included (issue #1504). Here
 * the position lives in its own computed; a row reads it only after matching
 * `trackId`, so a tick reaches exactly one row.
 *
 * `active` is the off-screen switch. Ionic hides but does not unmount a tab, so
 * Home keeps rendering while the user is on Search; passing `false` makes the
 * computeds return their last value WITHOUT reading the position, which drops
 * the dependency and stops the per-tick work entirely until the page is back.
 */
export function usePlaybackRowProgress(active?: Ref<boolean>): UiPlaybackProgress {
  const player = usePlayerStore()
  const playlist = usePlaylistStore()

  // Last values computed while active — what a frozen (off-screen) overlay
  // reports, so returning to the tab doesn't flash a zeroed radial.
  let frozenTrackId: string | null = null
  let frozenPct = 0
  let frozenState: UiTrackState = "playing"

  // Reads `active` (so re-activating recomputes) and nothing else when off.
  const isActive = (): boolean => active === undefined || active.value

  return reactive({
    // Frozen alongside the other two, and for the same reason. A track
    // finishing while the page is hidden moves `player.trackId` onto the next
    // lecture; an ungated read would hand the PREVIOUS lecture's frozen
    // `progressPct`/`state` to the new row, which is a wrong radial on a row
    // that never played. The three fields only mean anything together, so
    // they freeze and thaw together (issue #1615).
    trackId: computed(() => {
      if (!isActive()) return frozenTrackId
      frozenTrackId = player.trackId
      return frozenTrackId
    }),

    progressPct: computed(() => {
      if (!isActive()) return frozenPct
      frozenPct =
        player.durationMs > 0
          ? Math.min(100, Math.max(0, (player.positionMs / player.durationMs) * 100))
          : 0
      return frozenPct
    }),

    state: computed<UiTrackState>(() => {
      if (!isActive()) return frozenState
      const trackId = player.trackId
      // Mirrors the precedence the mapper used to apply inline: a completed
      // lecture the user is re-listening to stays "playing" until this pass
      // reaches the end. Duration not hydrated yet counts as playing rather
      // than flashing the wrong indicator.
      const progressing = player.durationMs <= 0 || player.positionMs < player.durationMs
      if (trackId === null || progressing) {
        frozenState = "playing"
        return frozenState
      }
      const entry = playlist.getEntryByTrackId(trackId)
      frozenState =
        entry && playlist.getCompletedAt(entry.item.id) != null ? "completed" : "playing"
      return frozenState
    }),
  })
}
