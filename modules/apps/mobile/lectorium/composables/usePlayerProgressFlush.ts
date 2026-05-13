import { onBeforeUnmount, onMounted } from "vue"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"

/**
 * App-root lifecycle hook that pushes the engine's last known
 * playback position into the journal whenever the page is hidden
 * (Safari tab switch, Android background, hard navigation). The
 * `useListeningSessionTracker` throttle inside the player session
 * can be up to ~5 s stale; this best-effort flush narrows the
 * gap so the user's "last played" position is durable when the
 * app is suspended.
 *
 * Listens to both `visibilitychange` (hide / unhide) and `pagehide`
 * (BFCache, full unload). Cleanly removes both listeners on unmount.
 */
export function usePlayerProgressFlush(): void {
  const player = usePlayerStore()

  function flush(): void {
    player.flushProgressNow()
  }
  function onVisibility(): void {
    if (document.hidden) flush()
  }

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", flush)
  })
  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pagehide", flush)
  })
}
