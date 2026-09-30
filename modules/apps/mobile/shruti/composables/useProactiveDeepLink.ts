import { onBeforeUnmount, onMounted } from "vue"
import router from "@shruti/router/index.js"
import { useShruti } from "@shruti/shruti.js"
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
 * id is lost, so the tap opens nothing. So we stash
 * the target session and flush it once the DBs are open: `afterEach`
 * re-checks on every navigation, so the deferred open lands the moment
 * Welcome replaces to `/tabs/*`. When the app is already foregrounded
 * the flush runs immediately.
 *
 * Notifications without `chatSessionId` in `extra` — most importantly
 * the daily reminder — are ignored, so this coexists with the other
 * notification surfaces.
 */
export function useProactiveDeepLink(): void {
  // Singleton imports — this handler fires at arbitrary app states (cold
  // start, background → foreground) so the Vue provide chain may not be
  // reachable. `useShruti()` resolves the composition-root singleton.
  const app = useShruti()
  let handle: PluginListenerHandle | null = null
  let removeAfterEach: (() => void) | null = null
  // Target session from a notification tap, held until the DBs are open.
  let pendingSessionId: string | null = null
  // Guard against firing a second `replace` while the first is still in
  // flight (afterEach fires on every navigation).
  let flushing = false

  function dbsReady(): boolean {
    return Boolean(app.databases.content && app.databases.user)
  }

  function flush(): void {
    if (pendingSessionId === null || !dbsReady() || flushing) return
    const sessionId = pendingSessionId
    flushing = true
    // Clear `pendingSessionId` ONLY once we've actually landed on chat.
    // `router.replace` resolves even when the guard redirects us back to
    // /welcome (DBs not open yet at that instant): the promise resolving
    // does NOT mean the navigation reached chat. Nulling it here would leave
    // `afterEach` nothing to retry, so the tapped session would never open.
    // Keep it pending until the active route is `chat`, letting `afterEach`
    // re-attempt after DB init.
    void router
      .replace({ name: "chat", query: { session: sessionId } })
      .then(() => {
        if (router.currentRoute.value.name === "chat") pendingSessionId = null
      })
      // A bounced or aborted navigation keeps the session pending, so `afterEach` retries.
      // eslint-disable-next-line no-restricted-syntax -- the pending session is the handling; afterEach retries it
      .catch(() => {})
      .finally(() => {
        flushing = false
      })
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
