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

export interface OutboxFlushResult {
  /**
   * `true` when journal rows for the outgoing account are STILL pending once
   * the drain is over. The wipe that follows deletes the device's only copy of
   * them, so the sign-out notice must say the last changes were lost instead
   * of claiming everything is safely in the account (#1883).
   */
  readonly stranded: boolean
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
 * {@link FLUSH_TIMEOUT_MS}, and no failure escapes — a sign-out must complete
 * whether or not the server is reachable.
 *
 * It reports what it achieved rather than swallowing it silently (#1883). The
 * sign-out notice used to promise the user's data "comes back when you sign
 * in" unconditionally, which is false for exactly the rows this function could
 * not deliver: the wipe that follows deletes the device's only copy. So the
 * outbox is re-read afterwards and {@link OutboxFlushResult.stranded} says
 * whether anything is still pending — from the timeout, a dead network, or a
 * region with no profile service at all.
 *
 * Does NOT pull. A pull would merge server rows into tables the wipe is about
 * to delete, which is work for nobody; the push is the only half that carries
 * information the device is the last holder of.
 */
export async function flushPendingOutbox(deps: FlushPendingOutboxDeps): Promise<OutboxFlushResult> {
  const { app, ownerId, getLiveOwnerId } = deps

  let repos
  try {
    repos = app.repositories()
  } catch {
    // Repos not open (cold boot) — nothing was journaled, nothing to flush.
    return { stranded: false }
  }
  const { syncOutbox, syncState, syncApply, unitOfWork } = repos
  // No journal was ever written, so there is nothing the wipe can destroy.
  if (!syncOutbox || !syncState || !syncApply) return { stranded: false }

  if (app.activeServer.value.profileBaseUrl) {
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
    } catch (err) {
      // Not the caller's problem to swallow any more — what a failed drain
      // costs the user is now carried in the result.
      console.warn("[sync] farewell outbox flush did not complete", err)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  // A region with no profile service never entered the branch above: nothing
  // was ever pushed there, so whatever is journaled is stranded by definition.

  try {
    // `listPending` is scoped the same way the drain was — same owner, same
    // watermark — so this asks precisely "did the push leave anything behind".
    // One row is all the answer needs.
    const watermark = await syncState.getPushedOutboxId()
    const pending = await syncOutbox.listPending(1, { ownerId, afterId: watermark })
    return { stranded: pending.length > 0 }
  } catch (err) {
    // Unable to tell — say nothing rather than alarm the user with a loss
    // that may not have happened.
    console.warn("[sync] could not read the outbox after the farewell flush", err)
    return { stranded: false }
  }
}
