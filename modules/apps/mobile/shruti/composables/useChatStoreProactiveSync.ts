import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { on } from "@shruti/proactive/events.js"
import { emitNotify } from "@shruti/notifications/notifyEvents.js"

/** What foreground toast (if any) a settled tick should surface. */
export type ProactiveToastPlan =
  | { kind: "none" }
  | { kind: "single" }
  | { kind: "grouped"; count: number }

/**
 * Decide the toast for a settled tick from how many proactive sessions were
 * unseen BEFORE it (`baseline`) versus AFTER (`unseenSize`). The growth is how
 * many messages newly surfaced this open: 0 → nothing (idle tick or a re-prep
 * of an already-seen row), 1 → the single-message toast, ≥2 → one grouped
 * toast carrying the count. Pure + exported so the thresholds are unit-tested.
 */
export function planProactiveToast(baseline: number, unseenSize: number): ProactiveToastPlan {
  const added = unseenSize - baseline
  if (added <= 0) return { kind: "none" }
  if (added === 1) return { kind: "single" }
  return { kind: "grouped", count: added }
}

/**
 * Bridges the proactive event bus to the chat store. Mounted once at
 * App.vue level — every `tick-ready` / `row-created` from the scheduler
 * triggers a `chatStore.refreshSessions()` so both the session list
 * and `unseenProactiveSessionIds` stay in sync without the scheduler
 * importing the store directly. Keeps the scheduler's dependency arrow
 * pointing inward.
 *
 * The foreground toast is COALESCED per tick: `row-prepped` only refreshes
 * (so the badge / per-session dot appears promptly), while the "you have new
 * message(s)" toast is emitted once on `tick-settled` for the whole batch.
 * Without this, a tick that preps N proactive rows fired N stacked toasts
 * one-by-one. Its background delivery is the scheduler's own separately-
 * scheduled notification, hence `whenBackground: "skip"` (no double notify).
 */
export function useChatStoreProactiveSync(): void {
  const chatStore = useChatStore()
  const { t } = useI18n()
  let unsubs: Array<() => void> = []

  // Coalescing state for the per-tick grouped toast. `unseenBaseline` is the
  // unseen count at the START of the current tick; the growth by `tick-settled`
  // is how many proactive messages newly surfaced this open. `sawPrepThisTick`
  // gates the flush so idle ticks (nothing prepped) do no extra work / no toast.
  let unseenBaseline = 0
  let sawPrepThisTick = false

  function refresh(): void {
    // Surface refresh failures instead of swallowing them. A throwing
    // `sessions.list` (e.g. a schema/query error) would otherwise empty
    // the session list silently — log so a broken refresh is visible.
    void chatStore.refreshSessions().catch((err) => {
      console.error("[proactive] chat session refresh failed", err)
    })
  }

  function onTickReady(): void {
    // Snapshot the unseen count before this tick preps anything (new rows are
    // still `pending`, so they aren't counted yet). `tick-settled` diffs
    // against this to know how many messages arrived — the basis for grouping.
    unseenBaseline = chatStore.unseenProactiveSessionIds.size
    sawPrepThisTick = false
    refresh()
  }

  function onRowPrepped(): void {
    // A row flipped `pending` → `ready`/`degraded`. `listUnseenSessionIds`
    // filters out `pending`, so refresh here or the badge / per-session dot
    // stays dark until the next tick / resume. The TOAST is deferred to
    // `tick-settled` so a batch of rows yields ONE grouped notification.
    sawPrepThisTick = true
    refresh()
  }

  async function onTickSettled(): Promise<void> {
    if (!sawPrepThisTick) return
    sawPrepThisTick = false
    // Re-read after all of this tick's preps landed, then measure how many
    // proactive messages newly surfaced (clamped — a user opening a session
    // mid-tick could shrink the set).
    await chatStore.refreshSessions().catch((err) => {
      console.error("[proactive] chat session refresh failed", err)
    })
    const unseen = chatStore.unseenProactiveSessionIds
    const plan = planProactiveToast(unseenBaseline, unseen.size)
    if (plan.kind === "none") return
    // Tap target: the top unseen session (grouped toasts still open into a
    // single session; the inbox shows the rest with their unread dots).
    const sessionId = [...unseen][0]
    if (!sessionId) return
    // Distinct title/body: the toast header falls back to `title` whenever the
    // session has none (proactive rules on the system session store `title:
    // null`). Reusing the body string there made header and body identical.
    emitNotify(
      plan.kind === "single"
        ? {
            title: t("notifications.proactiveNewMessageTitle"),
            body: t("notifications.proactiveNewMessageToast"),
            sessionId,
            whenBackground: "skip",
          }
        : {
            title: t("notifications.proactiveNewMessagesTitle"),
            body: t("notifications.proactiveNewMessagesToast", { count: plan.count }),
            sessionId,
            whenBackground: "skip",
          }
    )
  }

  onMounted(() => {
    unsubs = [
      on("tick-ready", onTickReady),
      on("row-created", refresh),
      on("row-prepped", onRowPrepped),
      // Coalescing boundary: emit the single grouped toast once the tick
      // that prepped the batch has fully settled.
      on("tick-settled", () => void onTickSettled()),
    ]
  })

  onBeforeUnmount(() => {
    for (const fn of unsubs) fn()
    unsubs = []
  })
}
