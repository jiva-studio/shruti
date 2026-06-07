import { onBeforeUnmount, onMounted } from "vue"
import router from "@lectorium/router/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
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
 * Mounted once in App.vue. When the user taps a proactive notification
 * we read `extra.chatSessionId` (set by the scheduler) and route into
 * that chat session.
 *
 * Cold-start race: Capacitor delivers the action event right after the
 * app mounts — which is BEFORE Welcome has opened the content/user DB.
 * A direct `router.push` at that point is bounced to `/welcome` by the
 * router guard (every `/tabs/*` needs both DBs open), and the session
 * id is lost — the source of "tap the push, nothing opens". So we stash
 * the target session and flush it once the DBs are open: `afterEach`
 * re-checks on every navigation, so the deferred open lands the moment
 * Welcome replaces to `/tabs/*`. When the app is already foregrounded
 * the flush runs immediately.
 *
 * Notifications without `chatSessionId` in `extra` — most importantly
 * the legacy daily reminder — are ignored, so this coexists with the
 * existing notification surface without behavioural change.
 */
export function useProactiveDeepLink(): void {
  // Singleton imports — this handler fires at arbitrary app states (cold
  // start, background → foreground) so the Vue provide chain may not be
  // reachable. `useLectorium()` resolves the composition-root singleton.
  const app = useLectorium()
  let handle: PluginListenerHandle | null = null
  let removeAfterEach: (() => void) | null = null
  // Target session from a notification tap, held until the DBs are open.
  let pendingSessionId: string | null = null

  function dbsReady(): boolean {
    return Boolean(app.databases.content && app.databases.user)
  }

  function flush(): void {
    if (pendingSessionId === null || !dbsReady()) return
    const sessionId = pendingSessionId
    pendingSessionId = null
    void router.replace({ name: "chat", query: { session: sessionId } })
  }

  onMounted(() => {
    void LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
      const sessionId = readChatSessionId(action.notification.extra)
      if (sessionId === null) return
      pendingSessionId = sessionId
      flush()
    }).then((h) => {
      handle = h
    })
    // Retry the deferred open after every navigation — the welcome → tabs
    // replace that follows DB init is what unblocks it on cold start.
    // `pendingSessionId` is cleared on the first successful flush, so this
    // is effectively one-shot per tap.
    removeAfterEach = router.afterEach(() => flush())
  })

  onBeforeUnmount(() => {
    void handle?.remove()
    handle = null
    removeAfterEach?.()
    removeAfterEach = null
  })
}
