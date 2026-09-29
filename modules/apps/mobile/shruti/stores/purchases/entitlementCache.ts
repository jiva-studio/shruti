import type { IPreferences } from "@ports/app/index.js"

const CACHE_KEY = "purchases.lastState"

/**
 * The last confirmed entitlement, mirrored to Preferences so a returning
 * subscriber sees Pro on cold start before the SDK round-trip answers.
 *
 * Every function takes the preferences port as a getter, resolved per call:
 * the store that owns the cache is created before the port is.
 */
export interface CachedEntitlement {
  activePackageId: string | undefined
  managementUrl: string | undefined
  appUserId: string | undefined
}

export async function readEntitlementCache(
  preferences: () => IPreferences
): Promise<CachedEntitlement | null> {
  try {
    const value = await preferences().get(CACHE_KEY)
    if (!value) return null
    return JSON.parse(value) as CachedEntitlement
  } catch {
    // An unreadable cache is the same as none: the SDK answer replaces it.
    return null
  }
}

export async function writeEntitlementCache(
  preferences: () => IPreferences,
  state: CachedEntitlement
): Promise<void> {
  const cached: CachedEntitlement = {
    activePackageId: state.activePackageId,
    managementUrl: state.managementUrl,
    appUserId: state.appUserId,
  }
  try {
    await preferences().set(CACHE_KEY, JSON.stringify(cached))
  } catch (e) {
    console.warn("[purchases] cache write failed", e)
  }
}

export async function clearEntitlementCache(preferences: () => IPreferences): Promise<void> {
  try {
    await preferences().remove(CACHE_KEY)
  } catch (e) {
    console.warn("[purchases] cache clear failed", e)
  }
}
