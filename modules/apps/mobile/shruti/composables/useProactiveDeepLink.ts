import { onBeforeUnmount, onMounted } from "vue"
import router from "@shruti/router/index.js"
import { LocalNotifications } from "@capacitor/local-notifications"
import type { PluginListenerHandle } from "@capacitor/core"

interface ProactiveExtra {
  readonly chatSessionId?: string
  readonly chatMessageId?: string
}

function readChatSessionId(extra: unknown): string | null {
  if (!extra || typeof extra !== "object") return null
  const sessionId = (extra as ProactiveExtra).chatSessionId
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null
}

/**
 * Global handler for `localNotificationActionPerformed` events.
 * Mounted once in App.vue. When a notification fires and the user
 * taps it, we read `extra.chatSessionId` (set by the proactive
 * scheduler when it scheduled the notification) and route into that
 * chat session.
 *
 * Notifications without `chatSessionId` in `extra` — most importantly
 * the legacy daily reminder — are ignored, so this listener can
 * coexist with the existing notification surface without behavioural
 * change.
 *
 * Cold-start path: Capacitor delivers a queued action event after the
 * app finishes init, so the listener fires whether the app was open
 * or launched by the tap.
 */
export function useProactiveDeepLink(): void {
  // Singleton import — the LocalNotification handler fires at arbitrary
  // app states (cold start, background → foreground) so the Vue
  // provide chain may not be reachable at call time.
  let handle: PluginListenerHandle | null = null

  onMounted(() => {
    void LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      const sessionId = readChatSessionId(action.notification.extra)
      if (sessionId === null) return
      void router.push({ name: "chat", query: { session: sessionId } })
    }).then((h) => {
      handle = h
    })
  })

  onBeforeUnmount(() => {
    void handle?.remove()
    handle = null
  })
}
