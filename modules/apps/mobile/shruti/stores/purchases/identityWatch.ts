import { watch, type WatchStopHandle } from "vue"
import {
  classifyIdentityChange,
  logInToRc,
  logOutOfRc,
  type Identity,
  type RcIdentityDeps,
} from "@shruti/stores/purchases/rcIdentity.js"

export interface IdentityWatchDeps {
  readonly identity: () => Identity
  /** Resolved per transition — the port and the auth store outlive no call. */
  readonly rc: () => RcIdentityDeps
  readonly track: (p: Promise<void>) => void
  /** Drop the optimistic cache: the incoming account is a different person. */
  readonly onAccountSwitch: () => void
}

/**
 * Bind RC's appUserID to our JWT `sub`. Fires once at registration, so a
 * session auth has already restored is picked up; every later transition
 * funnels through useAuthStore.applySession.
 */
export function watchRcIdentity(deps: IdentityWatchDeps): WatchStopHandle {
  return watch(
    deps.identity,
    (next, prev) => {
      const transition = classifyIdentityChange(next, prev)
      if (transition === "signOut") {
        deps.track(logOutOfRc(deps.rc()))
        return
      }
      if (transition === "none" || !next.userId) return
      if (transition === "accountSwitch") deps.onAccountSwitch()
      deps.track(logInToRc(deps.rc(), next.userId))
    },
    { immediate: true }
  )
}
