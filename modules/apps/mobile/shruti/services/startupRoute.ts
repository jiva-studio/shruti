import type { IPreferences } from "@ports/app/index.js"
import type { Shruti } from "@shruti/shruti.js"
import { STORAGE_ERROR_PATH } from "@shruti/router/databaseGuard.js"
import {
  readOnboardingCompleted,
  ONBOARDING_COMPLETED_KEY,
} from "@shruti/stores/useOnboardingStore.js"

/** Both databases open — the precondition every `/tabs/*` surface has, because
 *  they all read through `repositories()`. */
function isStorageUsable(app: Shruti, startupReady: boolean): boolean {
  return startupReady && !!app.databases.content && !!app.databases.user
}

/**
 * Where the app should land on this launch.
 *
 * **Must not reject.** It runs in the middle of `start()`, and everything after
 * it — the locale await, the mount, auth restore, purchases — is skipped if it
 * does, and a failed user-DB open would cost the whole run its session.
 * `repositories()` throws synchronously when a database is missing, so a
 * `.catch()` chained onto a call through it is never installed.
 *
 * The probe is therefore gated on the databases actually being open, and
 * wrapped as well — a `try` costs nothing and does not depend on `repositories()`
 * keeping its current failure mode.
 */
export async function resolveInitialRoute(
  app: Shruti,
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
      console.warn("[shruti] listening-history probe failed; assuming first launch", err)
      hasHistory = false
    }
    if (hasHistory) await preferences.set(ONBOARDING_COMPLETED_KEY, "true").catch(() => undefined)
  }

  return completedFlag || hasHistory ? "/tabs/home" : "/onboarding"
}
