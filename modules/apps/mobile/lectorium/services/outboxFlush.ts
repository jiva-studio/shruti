import { pushLocal } from "@usecases/sync/index.js"
import type { Lectorium } from "../lectorium.js"

/** Bound on the farewell push, so a dead network can't hold a sign-out open. */
const FLUSH_TIMEOUT_MS = 8000

export interface FlushPendingOutboxDeps {
  readonly app: Lectorium
  /** The account whose journal is drained — the one on its way out. */
  readonly ownerId: string
  /**
   * The identity live on the device, re-read between push rounds. A drain that
   * outlives the timeout must not keep POSTing under whatever token replaced
   * the one it started with.
   */
  readonly getLiveOwnerId: () => string | null
}

/**
 * Drain the outgoing account's outbox one last time, while its token is still
 * valid (#1773).
 *
 * Sign-out now wipes the device, and the wipe empties the journal — so a row
 * that is still pending at that moment has no second copy anywhere. Today it is
 * merely stranded (push is scoped to the current owner, and the identity switch
 * raises the watermark past it); after the wipe it would be lost. One push
 * ahead of `auth.signOut()` is what turns "stranded" into "delivered", and
 * whatever it cannot deliver the wipe then retires deliberately rather than
 * leaving it to rot behind a watermark.
 *
 * Best-effort by construction: gated on the same conditions as the sync engine
 * (a region with `profileBaseUrl`, wired engine repositories), bounded by
 * {@link FLUSH_TIMEOUT_MS}, and every failure is the caller's to swallow — a
 * sign-out must complete whether or not the server is reachable.
 *
 * Does NOT pull. A pull would merge server rows into tables the wipe is about
 * to delete, which is work for nobody; the push is the only half that carries
 * information the device is the last holder of.
 */
export async function flushPendingOutbox(deps: FlushPendingOutboxDeps): Promise<void> {
  const { app, ownerId, getLiveOwnerId } = deps
  if (!app.activeServer.value.profileBaseUrl) return

  let repos
  try {
    repos = app.repositories()
  } catch {
    // Repos not open (cold boot) — nothing was journaled, nothing to flush.
    return
  }
  const { syncOutbox, syncState, syncApply, unitOfWork } = repos
  if (!syncOutbox || !syncState || !syncApply) return

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pushLocal({
        gateway: app.syncClient,
        outbox: syncOutbox,
        apply: syncApply,
        syncState,
        unitOfWork,
        ownerId,
        getLiveOwnerId,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("outbox flush timeout")), FLUSH_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
