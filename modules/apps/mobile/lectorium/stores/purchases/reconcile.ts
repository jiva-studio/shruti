import { ref, type Ref } from "vue"

/**
 * How long a UI surface waits on the identity reconcile before it stops
 * rendering "in progress" — the same budget `purchase()` / `restore()` give
 * the very same promise. The auth watcher is immediate, so a cold start with
 * a restored session enters this window on every launch.
 */
export const RECONCILE_BUDGET_MS = 5000

export interface ReconcileTracker {
  /** True while an RC logIn/logOut is in flight AND still within its budget. */
  readonly reconciling: Ref<boolean>
  /** The reconcile outlived its budget: the subscribed answer is unknown, not "no". */
  readonly reconcileOverdue: Ref<boolean>
  track(p: Promise<void>): void
  wait(timeoutMs: number): Promise<void>
  reset(): void
}

/**
 * Tracks the in-flight RC identity reconcile.
 *
 * Dropping `reconciling` on the budget deliberately does NOT drop the promise:
 * `purchase()` and `restore()` still await the real round-trip through
 * `wait()`, because firing a receipt under the wrong app_user_id is a far
 * worse outcome than a stale-looking row. The budget only buys that no surface
 * renders "still thinking" forever.
 */
export function createReconcileTracker(): ReconcileTracker {
  const reconciling = ref(false)
  const reconcileOverdue = ref(false)
  let pending: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function track(p: Promise<void>): void {
    pending = p
    reconciling.value = true
    reconcileOverdue.value = false
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (pending !== p) return
      reconciling.value = false
      reconcileOverdue.value = true
      console.warn("[purchases] identity reconcile exceeded its budget", {
        budgetMs: RECONCILE_BUDGET_MS,
      })
    }, RECONCILE_BUDGET_MS)
    void p
      .finally(() => {
        if (pending !== p) return
        pending = null
        reconciling.value = false
        reconcileOverdue.value = false
        if (timer) clearTimeout(timer)
        timer = undefined
      })
      // Bookkeeping only; `p`'s own rejection is warned about at the call site
      // and surfaced through `wait`. Without this the derived promise rejects
      // with no handler on every failed logIn.
      .catch(() => undefined)
  }

  /**
   * Resolve once the in-flight reconcile settles, or after `timeoutMs`. Never
   * rejects: blocking a purchase on a network flake is worse UX than firing it
   * under the anonymous app_user_id and letting SUBSCRIBER_ALIAS reconcile it.
   */
  async function wait(timeoutMs: number): Promise<void> {
    const p = pending
    if (!p) return
    let waitTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      waitTimer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    try {
      const result = await Promise.race([
        p.then(() => "ok" as const).catch(() => "error" as const),
        timeout,
      ])
      if (result !== "ok") {
        console.warn("[purchases] RC.logIn did not settle before purchase/restore", {
          reason: result,
          timeoutMs,
        })
        // Metric (observability port doesn't exist yet — console-only).
        console.warn("[metric] rc_login_pre_purchase_failed_total +=1", { reason: result })
      }
    } finally {
      if (waitTimer) clearTimeout(waitTimer)
    }
  }

  function reset(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    reconciling.value = false
    reconcileOverdue.value = false
  }

  return { reconciling, reconcileOverdue, track, wait, reset }
}
