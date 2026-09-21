import { ref, type Ref } from "vue"
import type { CustomerState } from "@ports/app/purchases.js"
import {
  clearEntitlementCache,
  readEntitlementCache,
  writeEntitlementCache,
} from "@lectorium/stores/purchases/entitlementCache.js"

export interface EntitlementState {
  readonly activePackageId: Ref<string | undefined>
  readonly managementUrl: Ref<string | undefined>
  readonly appUserId: Ref<string | undefined>
  apply(s: CustomerState): void
  hydrate(): Promise<void>
  forget(opts: { managementUrl: "clear" | "keep" }): Promise<void>
}

/** The customer state as the UI reads it, mirrored to the cold-start cache. */
export function createEntitlementState(): EntitlementState {
  const activePackageId = ref<string | undefined>(undefined)
  const managementUrl = ref<string | undefined>(undefined)
  const appUserId = ref<string | undefined>(undefined)

  function apply(s: CustomerState): void {
    activePackageId.value = s.activePackageId
    managementUrl.value = s.managementUrl
    appUserId.value = s.appUserId
    void writeEntitlementCache(s)
  }

  async function hydrate(): Promise<void> {
    const cached = await readEntitlementCache()
    if (!cached) return
    activePackageId.value = cached.activePackageId
    managementUrl.value = cached.managementUrl
    appUserId.value = cached.appUserId
  }

  /**
   * Drop the entitlement in memory and on disk, synchronously enough that no
   * surface reads the departing account's Pro. An account switch keeps
   * `managementUrl` until the incoming state lands; a sign-out clears it.
   */
  async function forget(opts: { managementUrl: "clear" | "keep" }): Promise<void> {
    activePackageId.value = undefined
    if (opts.managementUrl === "clear") managementUrl.value = undefined
    await clearEntitlementCache()
  }

  return { activePackageId, managementUrl, appUserId, apply, hydrate, forget }
}
