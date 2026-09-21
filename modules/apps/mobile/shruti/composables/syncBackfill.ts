import type { useShruti } from "@shruti/shruti.js"
import { backfillLocal } from "@usecases/sync/index.js"

type Shruti = ReturnType<typeof useShruti>

/** Device-local marker prefix: `${…}${userId}` records that this account's
 *  pre-sync local rows have already been backfilled into the outbox on this
 *  device, so the one-time first-sync backfill never re-runs on a later launch. */
export const BACKFILL_MARKER_PREFIX = "sync.backfilled."

export interface BackfillDeps {
  readonly app: Pick<Shruti, "preferences" | "repositories">
  /** The account the engine is running for, or `null` before one exists. */
  readonly identity: () => string | null
  readonly isEnabled: () => boolean
}

export interface BackfillGuard {
  run: () => Promise<void>
  rearmForChats: () => Promise<void>
}

export function createBackfillGuard(deps: BackfillDeps): BackfillGuard {
  /** In-memory echo of the once-per-account marker: the account whose pre-sync
   *  rows were already enqueued this process. The marker survives restarts. */
  let backfilledUserId: string | null = null

  /**
   * "Sync chats" turned back on. Everything written locally while it was off
   * has no outbox row, and the once-per-account backfill that would enqueue it
   * has already run — so re-arm it. Dropping the persisted marker alone is not
   * enough: {@link backfilledUserId} echoes it in memory and survives the
   * delete for the life of the process, and the guard reads the echo first.
   *
   * The download side needs no prodding here: `pullAndMerge` rewinds to the
   * gap floor on the next cycle, which this kicks off immediately.
   */
  async function rearmForChats(): Promise<void> {
    const userId = deps.identity()
    backfilledUserId = null
    if (!userId) return
    try {
      await deps.app.preferences.remove(`${BACKFILL_MARKER_PREFIX}${userId}`)
    } catch {
      // Best-effort: the in-memory echo is already cleared, so the backfill
      // re-runs this process even if the marker outlives it.
    }
  }

  /** The repositories the backfill needs, or `null` before the user DB is
   *  open / on a build without the sync repos wired. */
  function syncRepositories() {
    try {
      const { syncBackfill, syncOutbox, syncState, syncApply, unitOfWork } = deps.app.repositories()
      if (!syncBackfill || !syncOutbox || !syncState || !syncApply) return null
      return { backfill: syncBackfill, outbox: syncOutbox, apply: syncApply, syncState, unitOfWork }
    } catch {
      return null
    }
  }

  /**
   * First-sync backfill (Lane E2b). The first time the engine runs for an
   * account on this device, enqueue its pre-sync local rows (created before
   * journaling existed) into the outbox so the following `runSync` uploads them
   * under that id. Runs **once per account** — guarded by a device-local
   * `sync.backfilled.<userId>` marker — and only when the engine is enabled.
   * Fires for anonymous users too (their id is stable per device); on an
   * upgrade-in-place the id is unchanged, so a marker already exists and the
   * backfill does not re-run.
   */
  async function run(): Promise<void> {
    if (!deps.isEnabled()) return
    const userId = deps.identity()
    if (!userId) return
    if (backfilledUserId === userId) return

    const markerKey = `${BACKFILL_MARKER_PREFIX}${userId}`
    const already = await deps.app.preferences.get(markerKey).catch(() => null)
    if (already) {
      backfilledUserId = userId
      return
    }

    const repos = syncRepositories()
    if (!repos) return

    try {
      await backfillLocal({ ...repos, ownerId: userId })
      await deps.app.preferences.set(markerKey, "1").catch(() => undefined)
      backfilledUserId = userId
    } catch (err) {
      // Non-fatal: leave the marker unset so the next cycle retries the
      // backfill; the reader's anti-join keeps a partial run idempotent.
      console.warn("[sync] backfill failed", err)
    }
  }

  return { run, rearmForChats }
}
