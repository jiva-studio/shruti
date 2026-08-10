import { computed, reactive, type Ref } from "vue"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
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
  let frozenPct = 0
  let frozenState: UiTrackState = "playing"

  // Reads `active` (so re-activating recomputes) and nothing else when off.
  const isActive = (): boolean => active === undefined || active.value

  return reactive({
    trackId: computed(() => player.trackId),

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
