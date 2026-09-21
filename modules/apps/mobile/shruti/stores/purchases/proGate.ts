import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"

export interface ProGateDeps {
  readonly isSubscribed: () => boolean
  readonly ready: () => boolean
  readonly init: () => Promise<void>
  readonly reconcileOverdue: () => boolean
  readonly waitForReconcile: (timeoutMs: number) => Promise<void>
  readonly budgetMs: number
}

/**
 * The single gate every Pro entry point goes through. Answers "may this person
 * use `feature`?", waiting out the bounded identity reconcile first, and opens
 * the paywall itself when the answer is no.
 *
 * `isSubscribed` reads FALSE for a paying subscriber for the length of RC's
 * `logIn` — a fresh install, a reinstall or an account switch has no cache to
 * seed it from. Reading it bare sent subscribers to a purchase screen;
 * refusing to act on it dropped the tap instead, which in a window entered on
 * every launch is a dead button. Awaiting turns both into a short wait.
 */
export async function ensureProAccess(
  deps: ProGateDeps,
  feature?: SubscriptionFeatureKey
): Promise<boolean> {
  if (deps.isSubscribed()) return true
  if (!deps.ready()) {
    // init() is single-flight, so this joins the run in progress.
    try {
      await deps.init()
    } catch (e) {
      console.warn("[purchases] init failed while gating a Pro feature", e)
    }
    if (deps.isSubscribed()) return true
  }
  // An unlucky subscriber lands on the paywall, which self-corrects into the
  // Manage view the moment RC answers. Skipped once the reconcile has blown
  // its budget: that is the same promise, so a second wait learns nothing.
  if (!deps.reconcileOverdue()) await deps.waitForReconcile(deps.budgetMs)
  if (deps.isSubscribed()) return true
  // Dynamic: the paywall store pulls in the router, whose module graph reaches
  // back into this one.
  const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
  usePaywallStore().requestOpen(feature)
  return false
}
