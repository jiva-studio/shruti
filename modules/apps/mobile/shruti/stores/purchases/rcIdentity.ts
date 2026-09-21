import type { CustomerState, IPurchases } from "@ports/app/purchases.js"

/** An auth session as the RevenueCat binding sees it. */
export interface Identity {
  readonly userId: string | null
  readonly anonymous: boolean
}

export type IdentityTransition = "none" | "signIn" | "crossLink" | "accountSwitch" | "signOut"

/**
 * Name the transition between two auth sessions.
 *
 * Both fields are needed: an anonymous session carries a real `auth.users` id,
 * so the id ALWAYS changes on sign-in. `anonymous` is what says whether the id
 * left behind was this same person's — a `crossLink` is the same device and
 * the same person, an `accountSwitch` is not.
 */
export function classifyIdentityChange(
  next: Identity,
  prev: Identity | undefined
): IdentityTransition {
  const before = prev?.userId ?? null
  if (!next.userId) return before ? "signOut" : "none"
  if (next.userId === before) return "none"
  if (!before) return "signIn"
  return prev?.anonymous && !next.anonymous ? "crossLink" : "accountSwitch"
}

/**
 * Whether RC's view disagrees with what the server last told us. The raw
 * server tier is the comparison point, not a coerced one, so a clock-skew
 * difference cannot drive a refresh loop.
 */
export function tierDisagrees(rcActive: boolean, rawTier: string): boolean {
  return rcActive !== (rawTier === "pro")
}

export interface RcIdentityDeps {
  readonly purchases: IPurchases
  readonly applyState: (s: CustomerState) => void
  readonly refreshTokens: () => Promise<unknown>
}

/**
 * Bind RC's appUserID to `userId`, rejecting if it fails — the caller reads
 * the same promise and reports the error path, so nothing is logged twice.
 */
export function logInToRc(deps: RcIdentityDeps, userId: string): Promise<void> {
  return deps.purchases
    .logIn(userId)
    .then(async (state) => {
      deps.applyState(state)
      if (!state.activePackageId) await recoverStrandedPurchase(deps)
    })
    .catch((e) => {
      console.warn("[purchases] logIn failed", e)
      throw e
    })
}

/**
 * Re-attach this device's store purchase to the signed-in id.
 *
 * `logIn` hits RC's "no merge" branch when the id already had an anonymous
 * alias (reinstall, account recreate), leaving a purchase made before signing
 * in stranded on the old anon id. Gated on "no entitlement" so users who
 * already have Pro are not synced indiscriminately.
 */
async function recoverStrandedPurchase(deps: RcIdentityDeps): Promise<void> {
  try {
    const recovered = await deps.purchases.recoverPurchases()
    deps.applyState(recovered)
    if (recovered.activePackageId) await deps.refreshTokens()
  } catch (e) {
    console.warn("[purchases] recoverPurchases failed", e)
  }
}

export function logOutOfRc(deps: RcIdentityDeps): Promise<void> {
  return deps.purchases
    .logOut()
    .then((state) => {
      deps.applyState(state)
    })
    .catch((e) => {
      console.warn("[purchases] logOut failed", e)
      throw e
    })
}
