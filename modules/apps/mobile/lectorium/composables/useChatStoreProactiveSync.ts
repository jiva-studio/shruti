import { onBeforeUnmount, onMounted } from "vue"
import { useChatStore } from "@lectorium/stores/useChatStore.js"
import { on } from "@lectorium/proactive/events.js"

/**
 * Bridges the proactive event bus to the chat store. Mounted once at
 * App.vue level — every `tick-ready` / `row-created` from the scheduler
 * triggers a `chatStore.refreshSessions()` so both the session list
 * and `unseenProactiveSessionIds` stay in sync without the scheduler
 * importing the store directly. Keeps the scheduler's dependency arrow
 * pointing inward.
 */
export function useChatStoreProactiveSync(): void {
  const chatStore = useChatStore()
  let unsubs: Array<() => void> = []

  function refresh(): void {
    // Surface refresh failures instead of swallowing them. A throwing
    // `sessions.list` (e.g. a schema/query error) would otherwise empty
    // the session list silently — log so a broken refresh is visible.
    void chatStore.refreshSessions().catch((err) => {
      console.error("[proactive] chat session refresh failed", err)
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
      on("row-prepped", refresh),
    ]
  })

  onBeforeUnmount(() => {
    for (const fn of unsubs) fn()
    unsubs = []
  })
}
