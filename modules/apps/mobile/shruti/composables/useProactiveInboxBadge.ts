import { computed, onMounted, type ComputedRef } from "vue"
import { useChatStore } from "@shruti/stores/useChatStore.js"

export interface UseProactiveInboxBadgeReturn {
  /** Unread count surfaced as the chat-tab Sadhu dot. Derived from
   *  `chatStore.unseenProactiveSessionIds.size` — the same set that
   *  drives the per-session dots, so the two indicators can never
   *  drift apart. The dot lights up iff there's at least one session
   *  whose proactive content hasn't been opened. */
  readonly count: ComputedRef<number>
}

/**
 * Tab-bar Sadhu badge. Pure derivation from `useChatStore`'s unseen
 * set — no watermark, no polling, no separate `markSeen` to keep in
 * sync. Opening a session via `chatStore.openSession` is what clears
 * the underlying SQL `seen_at`, which propagates here on the next
 * `refreshSessions`.
 *
 * On mount we kick a refreshSessions so the badge populates ASAP —
 * without this, the user has to wait for the scheduler's first tick
 * (≤5s retry cadence) before the dot appears. TabsLayout mounts after
 * Welcome finishes (so both DBs are open by then), and Ionic keeps the
 * layout alive across tab switches — so this fires exactly once per
 * cold-start, which is what we want.
 */
export function useProactiveInboxBadge(): UseProactiveInboxBadgeReturn {
  const chatStore = useChatStore()
  const count = computed(() => chatStore.unseenProactiveSessionIds.size)
  onMounted(() => {
    void chatStore.refreshSessions().catch(() => undefined)
  })
  return { count }
}
