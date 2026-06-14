import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { on } from "@shruti/proactive/events.js"
import { emitNotify } from "@shruti/notifications/notifyEvents.js"

/**
 * Bridges the proactive event bus to the chat store. Mounted once at
 * App.vue level — every `tick-ready` / `row-created` from the scheduler
 * triggers a `chatStore.refreshSessions()` so both the session list
 * and `unseenProactiveSessionIds` stay in sync without the scheduler
 * importing the store directly. Keeps the scheduler's dependency arrow
 * pointing inward.
 *
 * On `row-prepped` it also emits a notify intent so `useUserNotifier`
 * surfaces a foreground toast for the new proactive message — its background
 * delivery is the scheduler's own separately-scheduled notification, hence
 * `whenBackground: "skip"` (no double notification).
 */
export function useChatStoreProactiveSync(): void {
  const chatStore = useChatStore()
  const { t } = useI18n()
  let unsubs: Array<() => void> = []

  function refresh(): void {
    // Surface refresh failures instead of swallowing them. A throwing
    // `sessions.list` (e.g. a schema/query error) would otherwise empty
    // the session list silently — log so a broken refresh is visible.
    void chatStore.refreshSessions().catch((err) => {
      console.error("[proactive] chat session refresh failed", err)
    })
  }

  async function onRowPrepped(): Promise<void> {
    await chatStore.refreshSessions().catch((err) => {
      console.error("[proactive] chat session refresh failed", err)
    })
    // A proactive message just became visible — surface it. The presenter
    // shows a toast only when foreground; backgrounded delivery is the
    // scheduler's own notification, so we skip the background path here.
    const unseen = chatStore.unseenProactiveSessionIds
    const sessionId = unseen.size > 0 ? [...unseen][0] : undefined
    if (!sessionId) return
    // Distinct title/body: the toast header falls back to `title` whenever the
    // session has none (proactive rules on the system session store `title:
    // null`). Reusing the body string there made the header and body identical.
    emitNotify({
      title: t("notifications.proactiveNewMessageTitle"),
      body: t("notifications.proactiveNewMessageToast"),
      sessionId,
      whenBackground: "skip",
    })
  }

  onMounted(() => {
    unsubs = [
      on("tick-ready", refresh),
      on("row-created", refresh),
      // Crucial: `row-prepped` fires when `prep_state` flips from
      // `pending` → `ready`/`degraded`. `listUnseenSessionIds` filters
      // out `pending`, so without listening here the badge stays dark
      // until the next 30-min tick or manual nav refreshes the set.
      on("row-prepped", () => void onRowPrepped()),
    ]
  })

  onBeforeUnmount(() => {
    for (const fn of unsubs) fn()
    unsubs = []
  })
}
