import { Preferences } from "@capacitor/preferences"

const CACHE_KEY = "purchases.lastState"

/**
 * The last confirmed entitlement, mirrored to Preferences so a returning
 * subscriber sees Pro on cold start before the SDK round-trip answers.
 */
export interface CachedEntitlement {
  activePackageId: string | undefined
  managementUrl: string | undefined
  appUserId: string | undefined
}

export async function readEntitlementCache(): Promise<CachedEntitlement | null> {
  try {
    const { value } = await Preferences.get({ key: CACHE_KEY })
    if (!value) return null
    return JSON.parse(value) as CachedEntitlement
  } catch {
    return null
  }
}

export async function writeEntitlementCache(state: CachedEntitlement): Promise<void> {
  const cached: CachedEntitlement = {
    activePackageId: state.activePackageId,
    managementUrl: state.managementUrl,
    appUserId: state.appUserId,
  }
  try {
    await Preferences.set({ key: CACHE_KEY, value: JSON.stringify(cached) })
  } catch (e) {
    console.warn("[purchases] cache write failed", e)
  }
}

export async function clearEntitlementCache(): Promise<void> {
  try {
    await Preferences.remove({ key: CACHE_KEY })
  } catch (e) {
    console.warn("[purchases] cache clear failed", e)
  }
}
