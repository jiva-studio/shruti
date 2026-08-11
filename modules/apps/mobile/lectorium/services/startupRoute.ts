import type { IPreferences } from "@ports/app/index.js"
import type { Lectorium } from "@lectorium/lectorium.js"
import { STORAGE_ERROR_PATH } from "@lectorium/router/databaseGuard.js"
import {
  readOnboardingCompleted,
  ONBOARDING_COMPLETED_KEY,
} from "@lectorium/stores/useOnboardingStore.js"

/** Both databases open — the precondition every `/tabs/*` surface has, because
 *  they all read through `repositories()`. */
export function isStorageUsable(app: Lectorium, startupReady: boolean): boolean {
  return startupReady && !!app.databases.content && !!app.databases.user
}

/**
 * Where the app should land on this launch.
 *
 * **Must not reject.** It runs in the middle of `start()`, and everything after
 * it — the locale await, the mount, auth restore, purchases — is skipped if it
 * does. That is what made a failed user-DB open cost the whole run its session:
 * `repositories()` throws SYNCHRONOUSLY when a database is missing, so the
 * `.catch()` that used to be chained onto `hasAny()` was never installed and the
 * rejection escaped `start()` into the last-resort handler (#1738).
 *
 * The probe is therefore gated on the databases actually being open, and
 * wrapped as well — a `try` costs nothing and does not depend on `repositories()`
 * keeping its current failure mode.
 */
export async function resolveInitialRoute(
  app: Lectorium,
  preferences: IPreferences,
  startupReady: boolean
): Promise<string> {
  if (!isStorageUsable(app, startupReady)) return STORAGE_ERROR_PATH

  // Skip first-launch onboarding for established users: the explicit
  // `onboarding.completed` flag (set at the end of the flow), OR any prior
  // listening session — the reliable signal for someone upgrading from a
  // pre-onboarding build, where the flag was never written. Stamp the flag
  // once inferred so later launches skip the DB probe.
  const completedFlag = await readOnboardingCompleted(preferences).catch(() => false)
  let hasHistory = false
  if (!completedFlag) {
    try {
      hasHistory = await app.repositories().listeningSessions.hasAny()
    } catch (err) {
      console.warn("[lectorium] listening-history probe failed; assuming first launch", err)
      hasHistory = false
    }
    if (hasHistory) await preferences.set(ONBOARDING_COMPLETED_KEY, "true").catch(() => undefined)
  }

  return completedFlag || hasHistory ? "/tabs/home" : "/onboarding"
}
