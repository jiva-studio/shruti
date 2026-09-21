import type { Lectorium } from "@lectorium/lectorium.js"
import { wipeLocalUserData, type WipeLocalUserDataOptions } from "@lectorium/services/dataWipe.js"
import { flushPendingOutbox } from "@lectorium/services/outboxFlush.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"

/**
 * Last push under the outgoing token. The wipe that follows empties the
 * journal, and a row still pending has no second copy anywhere — so what
 * this fails to deliver is reported, not swallowed. Returns whether rows
 * were left behind.
 */
export async function pushPendingOutbox(
  app: Lectorium,
  ownerId: string,
  getLiveOwnerId: () => string | null
): Promise<boolean> {
  try {
    const flush = await flushPendingOutbox({ app, ownerId, getLiveOwnerId })
    return flush.stranded
  } catch (e) {
    console.warn("[auth] outbox flush before sign-out failed:", e)
    return true
  }
}

export interface ReleaseDeviceOptions {
  readonly wipeLocal: boolean
  readonly wipe?: WipeLocalUserDataOptions
  /** Names the caller in the warnings this emits. */
  readonly context: string
}

/**
 * Wipe local user data and detach RevenueCat, in that order.
 *
 * Each step is independent and non-fatal: a failure here must not trap the
 * user in a session they asked to leave. The RC detach runs even without a
 * wipe — the purchases watcher clears the cached entitlement only on a
 * successful SDK logOut, so a session whose configure() threw would otherwise
 * hand the departing account's Pro to whoever picks up the device next.
 */
export async function releaseDevice(app: Lectorium, opts: ReleaseDeviceOptions): Promise<void> {
  if (opts.wipeLocal) {
    try {
      await wipeLocalUserData(app, opts.wipe)
    } catch (e) {
      console.warn(`[auth] wipe failed during ${opts.context}:`, e)
    }
  }
  try {
    await usePurchasesStore().logOut()
  } catch (e) {
    console.warn(`[auth] RC logOut on ${opts.context} failed:`, e)
  }
}
