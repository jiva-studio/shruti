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
 */
export function useReloadOnPlayback(
  playing: Ref<boolean>,
  reload: () => void | Promise<void>,
  intervalMs: number = DEFAULT_INTERVAL_MS
): void {
  let pollHandle: ReturnType<typeof setInterval> | null = null

  function stopPolling(): void {
    if (pollHandle !== null) {
      clearInterval(pollHandle)
      pollHandle = null
    }
  }

  watch(playing, (next, prev) => {
    if (prev && !next) {
      stopPolling()
      void reload()
    } else if (!prev && next) {
      stopPolling()
      pollHandle = setInterval(() => void reload(), intervalMs)
    }
  })

  onBeforeUnmount(stopPolling)
}
