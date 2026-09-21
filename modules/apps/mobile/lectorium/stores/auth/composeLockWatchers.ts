import { watch, type WatchSource } from "vue"

/** The identity edges that can void a chat composer lockout. */
export type ComposeLockEdge = "identity" | "entitlement" | "quota" | "authorized"

export type EdgeValue = string | boolean | null | undefined

const RELEASE_RULES: Record<ComposeLockEdge, (next: EdgeValue, prev: EdgeValue) => boolean> = {
  // Sign-in, sign-out and account switch alike: the deadline was bound to the
  // previous identity's quota bucket and means nothing for the new one.
  identity: (next, prev) => next !== prev,
  // Only the upgrade edge. Pro's quota policy is a different one, so a lockout
  // armed under free is moot; an expiry back to free deserves its own bookkeeping.
  entitlement: (next, prev) => next === true && prev !== true,
  // A token rotation carrying a fresh bucket id under the same user. Transitions
  // through the empty string are the initial restore, where no lockout was live.
  quota: (next, prev) => next !== prev && Boolean(next) && Boolean(prev),
  // The server may link an anonymous session in place, keeping both the user id
  // and the quota id and flipping only `anonymous` — no other rule fires then,
  // and the limit banner's "authorize" CTA would visibly do nothing.
  authorized: (next, prev) => next === true && prev !== true,
}

export function releasesComposeLock(
  edge: ComposeLockEdge,
  next: EdgeValue,
  prev: EdgeValue
): boolean {
  return RELEASE_RULES[edge](next, prev)
}

export interface ComposeLockWatchDeps {
  readonly userId: WatchSource<string | null>
  readonly isPro: WatchSource<boolean>
  readonly quotaId: WatchSource<string>
  readonly signedIn: WatchSource<boolean>
  readonly onIdentityChange: (userId: string | null) => void
  readonly release: () => void
}

/**
 * Watch the identity edges and release the chat composer lockout on each.
 * Whether the swallowed question is re-asked is the chat store's call.
 */
export function watchComposeLockReleases(deps: ComposeLockWatchDeps): void {
  watch(deps.userId, (next, prev) => {
    if (!releasesComposeLock("identity", next, prev)) return
    deps.onIdentityChange(next)
    deps.release()
  })
  watchEdge(deps.isPro, "entitlement", deps.release)
  watchEdge(deps.quotaId, "quota", deps.release)
  watchEdge(deps.signedIn, "authorized", deps.release)
}

function watchEdge<T extends EdgeValue>(
  source: WatchSource<T>,
  edge: ComposeLockEdge,
  release: () => void
): void {
  watch(source, (next, prev) => {
    if (releasesComposeLock(edge, next, prev)) release()
  })
}
