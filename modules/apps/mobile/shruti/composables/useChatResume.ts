import { onBeforeUnmount, onMounted } from "vue"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import { useChatStore } from "@shruti/stores/useChatStore.js"

/**
 * Recovers chat turns left in-flight when the app was backgrounded /
 * killed mid-stream. On cold start and on every return to the foreground
 * it asks the chat store to poll the server's turn buffer and replay any
 * finished result — so an answer that arrived while the app was frozen is
 * rebuilt instead of lost.
 *
 * The native app-lifecycle listener (`@capacitor/app`) lives HERE, in a
 * composable mounted once by `App.vue` — same pattern as
 * `useProactiveScheduler`. The store stays free of Capacitor and just
 * exposes `resumePendingTurns()`.
 */
export function useChatResume(): void {
  const store = useChatStore()
  let resumeHandle: PluginListenerHandle | null = null

  onMounted(() => {
    // Cold start: recover anything left pending from a previous run.
    void store.resumePendingTurns()
    void CapApp.addListener("appStateChange", (state) => {
      if (state.isActive) void store.resumePendingTurns()
    })
      .then((handle) => {
        resumeHandle = handle
      })
      .catch(() => undefined)
  })

  onBeforeUnmount(() => {
    void resumeHandle?.remove()
    resumeHandle = null
  })
}
