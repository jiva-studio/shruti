/**
 * Where a navigation goes when the databases the app runs on are not open.
 *
 * The guard used to send those navigations to `/onboarding`, whose `finish()`
 * replaces to `/tabs/home` — straight back into the guard. With a user DB that
 * failed to open (a state `services/startup.ts` reaches deliberately) that is a
 * loop with no error on screen and no exit but a reinstall (#1724).
 *
 * `/storage-error` is a terminal route instead: it says what failed and offers
 * a retry. It is kept out of this module's UI so the decision below stays
 * testable without Ionic or a DOM.
 */
export const STORAGE_ERROR_PATH = "/storage-error"

/**
 * Paths the guard never redirects.
 *
 * `/` only ever redirects onward (to `/tabs/home`), and that target is checked
 * on its own. `/onboarding` is the first-launch target, which startup picks
 * only once both databases are open. `/storage-error` must be reachable no
 * matter what — it is the screen that reports the failure.
 */
const ALWAYS_OPEN: ReadonlySet<string> = new Set(["/", "/onboarding", STORAGE_ERROR_PATH])

export interface DatabaseState {
  /** Whether the composition root exists yet (`isLectoriumInitialized`). */
  readonly initialized: boolean
  /** Whether the content catalog is open. */
  readonly content: boolean
  /** Whether the user database is open. */
  readonly user: boolean
}

/**
 * The path `to` should be redirected to, or `null` to let it through.
 *
 * Every `/tabs/*` surface reads through `Lectorium.repositories()`, which
 * throws unless BOTH databases are open — so a missing user DB is not a
 * degraded catalog, it is a screen that cannot render. The honest answer is to
 * say so once, not to bounce the user around the app.
 */
export function resolveDatabaseRedirect(to: string, state: DatabaseState): string | null {
  if (ALWAYS_OPEN.has(to)) return null
  // Before the composition root exists there is nothing to ask; the very first
  // navigation `router.install()` triggers arrives here.
  if (!state.initialized) return null
  if (state.content && state.user) return null
  return STORAGE_ERROR_PATH
}
