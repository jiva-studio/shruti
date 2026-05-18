import { ref, onBeforeUnmount, onMounted, type Ref } from "vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useConfig } from "@lectorium/composables/useConfig.js"

const POLL_INTERVAL_MS = 30 * 1000

export interface UseProactiveInboxBadgeReturn {
  /** Unread count surfaced as a chat-tab badge dot. Reactive. */
  readonly count: Ref<number>
  /** Recompute the count from `chat_messages_proactive_state`. Cheap
   *  enough to call from a 30s timer or on every route change. */
  refresh(): Promise<void>
  /** Mark every currently-visible proactive message as seen. Sets a
   *  watermark in user-config and zeroes the badge. */
  markSeen(): Promise<void>
}

/**
 * Reactive unread count of agent-initiated chat messages. "Unread" is
 * defined as any proactive message in `ready`/`degraded` whose
 * `created_at` is newer than the watermark — the watermark advances
 * each time the user enters the chat tab (`markSeen()` from
 * `TabsLayout.vue`).
 *
 * Polling every 30 s is overkill but tiny — the scheduler's own tick
 * is far less frequent, and a watch on the proactive repo is awkward
 * because the rows live in user.db (one IndexedDB / SQLite file across
 * adapters).
 */
export function useProactiveInboxBadge(): UseProactiveInboxBadgeReturn {
  const app = useLectorium()
  const watermark = useConfig<number>("proactive.inboxLastSeenAtMs", 0)
  const count = ref<number>(0)
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    try {
      const repo = app.repositories().proactiveState
      const live = await repo.listByPrepStates(["ready", "degraded"])
      const todayLocal = todayLocalDate()
      let next = 0
      for (const e of live) {
        if (e.visibleOn !== null && e.visibleOn > todayLocal) continue
        if (e.createdAt <= watermark.value) continue
        next += 1
      }
      count.value = next
    } catch {
      // Repos not ready yet — leave count untouched.
    }
  }

  async function markSeen(): Promise<void> {
    watermark.value = Date.now()
    count.value = 0
  }

  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
  })

  onBeforeUnmount(() => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  })

  return { count, refresh, markSeen }
}

function todayLocalDate(): string {
  const d = new Date()
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
