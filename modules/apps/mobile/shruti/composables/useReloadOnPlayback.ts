import { onBeforeUnmount, watch, type Ref } from "vue"

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Calls `reload` whenever the player transitions running ↔ stopped, and
 * additionally polls every `intervalMs` milliseconds while playback is
 * active. Stops polling on pause/stop and on component unmount.
 *
 * Useful for surfaces (Home activity, Settings stats preview) that want
 * a near-real-time view of session-derived data without reading from a
 * shared cache more often than necessary.
 *
 * `onScreen` is the off-screen switch. Ionic hides but does not unmount a tab
 * page, so a minute-by-minute poll on a hidden surface keeps reading the DB
 * and re-rendering a widget nobody can see, for as long as the lecture plays
 * (issue #1615). Polling stops while it is false and resumes on return; the
 * running ↔ stopped reload is left alone, since it costs one read and is what
 * keeps the surface correct for the next time it is shown.
 */
export function useReloadOnPlayback(
  playing: Ref<boolean>,
  reload: () => void | Promise<void>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  onScreen?: Ref<boolean>
): void {
  let pollHandle: ReturnType<typeof setInterval> | null = null

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle)
      pollHandle = null
    }
  }

  function startPolling(): void {
    stopPolling()
    if (onScreen !== undefined && !onScreen.value) return
    pollHandle = setInterval(() => void reload(), intervalMs)
  }

  // `immediate` so a mount while playback is already active (the floating
  // player persists across views) starts polling right away instead of
  // waiting for the next ↔ transition. On the immediate run `prev` is
  // undefined, treated as the not-playing baseline.
  watch(
    playing,
    (next, prev) => {
      if (prev && !next) {
        stopPolling()
        void reload()
      } else if (!prev && next) {
        // Load once immediately (covers mounting while playback is already
        // active — otherwise the surface shows stale data until the first
        // interval tick) and then poll.
        void reload()
        startPolling()
      }
    },
    { immediate: true }
  )

  if (onScreen !== undefined) {
    watch(onScreen, (visible) => {
      if (!visible) stopPolling()
      else if (playing.value) startPolling()
    })
  }

  onBeforeUnmount(stopPolling)
}
