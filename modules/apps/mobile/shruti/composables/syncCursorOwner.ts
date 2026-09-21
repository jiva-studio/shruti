import type { useShruti } from "@shruti/shruti.js"
import { adoptAnonymousChanges } from "@usecases/sync/index.js"
import { BACKFILL_MARKER_PREFIX } from "@shruti/composables/syncBackfill.js"

type Shruti = ReturnType<typeof useShruti>

/** Device-local marker: the `userId` the pull cursor currently belongs to. */
const CURSOR_OWNER_KEY = "sync.cursorOwner"
/** Whether that account is anonymous ("1" / "0"). Absent reads as NOT
 *  anonymous, which only forgoes the handover. */
const CURSOR_OWNER_ANON_KEY = "sync.cursorOwnerAnon"
/** Where an anonymous {@link CURSOR_OWNER_KEY} came from. Absent reads as NOT
 *  adoptable. */
const CURSOR_OWNER_ORIGIN_KEY = "sync.cursorOwnerOrigin"
/** Nothing preceded this anonymous identity on the device, so it is the same
 *  human as the account that claims it. The only origin adoption accepts. */
const ORIGIN_FIRST_RUN = "first-run"
/** The anonymous identity took over from another one — whoever wrote under it
 *  is not provably the account that signs in next. */
const ORIGIN_REPLACED = "replaced"
/** Highest outbox id retired by an identity change that did NOT hand the
 *  journal over; rows at or below it must never be adopted by a later account.
 *  `pushed_outbox_id` cannot answer that — a plain push advances it too. */
const RETIRED_OUTBOX_KEY = "sync.retiredOutboxId"
const ANON_FLAG = "1"

export interface CursorOwnerDeps {
  readonly app: Pick<Shruti, "preferences" | "preferenceKeys" | "repositories">
  /** The identity the engine sees right now. */
  readonly identity: () => { userId: string | null; anonymous: boolean }
  readonly isEnabled: () => boolean
}

/**
 * `sync_state` is keyed by device, so its `pull_cursor` survives a sign-out
 * (which does not wipe the DB) — but the cursor is a high-water mark in the
 * server's GLOBAL change log for ONE account's filtered view. On a different
 * owner it is rewound to 0 so the new identity re-pulls its whole history (an
 * idempotent LWW no-op on rows it already has), and the previous owner's
 * un-pushed journal is retired by raising `pushed_outbox_id`.
 *
 * The exception is an anonymous identity the same human later claims by
 * signing in: retiring there would strand the whole anonymous period, so that
 * transition hands the journal over (see {@link adoptAnonymousChanges}) — but
 * only from a first-run session, since one that replaced another identity may
 * belong to somebody else.
 *
 * Runs once per account per process, guarded by an in-memory echo.
 */
export function createCursorOwnerGuard(deps: CursorOwnerDeps): () => Promise<void> {
  /** In-memory echo of the cursor-owner marker: the account the local pull
   *  cursor currently belongs to. The persisted marker survives restarts. */
  let cursorOwnerId: string | null = null
  /** In-memory echo of that account's anonymity — part of the marker, so an
   *  upgrade-in-place (same id, `anonymous` flipping false) is re-recorded. */
  let cursorOwnerAnon: boolean | null = null

  async function readStoredOwner(): Promise<{
    stored: string | null
    storedAnon: string | null
    storedOrigin: string | null
  }> {
    const stored = await deps.app.preferences.get(CURSOR_OWNER_KEY).catch(() => null)
    const storedAnon = await deps.app.preferences.get(CURSOR_OWNER_ANON_KEY).catch(() => null)
    let storedOrigin = await deps.app.preferences.get(CURSOR_OWNER_ORIGIN_KEY).catch(() => null)
    // Devices that recorded an anonymous owner before the origin marker existed
    // can still prove their provenance from what else is on disk.
    if (storedOrigin === null && storedAnon === ANON_FLAG && stored !== null) {
      storedOrigin = await recoverFirstRunOrigin(stored)
    }
    return { stored, storedAnon, storedOrigin }
  }

  /** The repositories the reset needs, or `null` before the user DB is open. */
  function syncRepositories() {
    try {
      const { syncApply, syncOutbox, syncState, unitOfWork } = deps.app.repositories()
      if (!syncState) return null
      return { syncApply, syncOutbox, syncState, unitOfWork }
    } catch {
      return null
    }
  }

  /**
   * Provenance of the identity taking over. An anonymous one is provably the
   * same human as the account that claims it later only when nothing preceded
   * it on this device. A signed-in owner has no origin of its own — adoption
   * reads this for an anonymous one.
   */
  function provenanceFor(
    anonymous: boolean,
    stored: string | null,
    storedOrigin: string | null
  ): string | null {
    if (!anonymous) return storedOrigin
    return stored === null ? ORIGIN_FIRST_RUN : ORIGIN_REPLACED
  }

  /** Rewind the cursor and either hand the previous owner's journal over or
   *  retire it. */
  async function takeOverFrom(
    repos: NonNullable<ReturnType<typeof syncRepositories>>,
    stored: string,
    userId: string,
    storedAnon: string | null,
    storedOrigin: string | null
  ): Promise<void> {
    const { syncApply, syncOutbox, syncState, unitOfWork } = repos
    const adopt =
      storedAnon === ANON_FLAG && storedOrigin === ORIGIN_FIRST_RUN && syncOutbox && syncApply
        ? { outbox: syncOutbox, apply: syncApply }
        : null
    const outboxTail = syncOutbox ? await syncOutbox.latestId() : null
    const retiredId = adopt ? await readRetiredOutboxId() : 0
    await unitOfWork.run(async (tx) => {
      await syncState.setPullCursor(0)
      await syncState.setAckedSeq(0)
      if (adopt) {
        // No watermark raise: the rows it would retire are exactly the ones
        // being handed over. `tx` must be passed — `unitOfWork` is shared by
        // every `user.db` repository, and an inner `run` without the handle
        // queues behind this block and dead-locks every write.
        await adoptAnonymousChanges({
          ...adopt,
          unitOfWork,
          fromOwnerId: stored,
          toOwnerId: userId,
          unownedAfterId: retiredId,
          tx,
        })
        return
      }
      if (outboxTail === null) return
      // Clamp: `setPushedOutboxId` is a bare column write, and a tail BELOW the
      // current mark (a pruned or restored journal) would rewind it and
      // un-retire the previous account's unowned rows.
      const prev = await syncState.getPushedOutboxId()
      if (outboxTail > prev) await syncState.setPushedOutboxId(outboxTail)
    })
    if (!adopt && outboxTail !== null) await raiseRetiredOutboxId(outboxTail)
  }

  async function ensureCursorOwner(): Promise<void> {
    if (!deps.isEnabled()) return
    const { userId, anonymous } = deps.identity()
    if (!userId) return
    if (cursorOwnerId === userId && cursorOwnerAnon === anonymous) return

    const { stored, storedAnon, storedOrigin } = await readStoredOwner()
    // Same account — including the in-place anonymous upgrade, where only the
    // flag moves. The origin is left exactly as found: guessing one would be
    // guessing whether a sign-out happened.
    if (stored === userId) {
      await recordOwner(userId, anonymous, storedAnon, storedOrigin, storedOrigin)
      return
    }

    const repos = syncRepositories()
    if (repos === null) return
    try {
      // A first-ever owner (stored === null) owns everything journaled so far,
      // so neither side is touched; recording ownership is what makes a later
      // switch detectable.
      if (stored !== null) await takeOverFrom(repos, stored, userId, storedAnon, storedOrigin)
      await recordOwner(
        userId,
        anonymous,
        storedAnon,
        provenanceFor(anonymous, stored, storedOrigin),
        storedOrigin
      )
    } catch (err) {
      // Non-fatal: leave the marker unset so the next cycle retries the reset.
      // Everything it does is idempotent, so a resumed run is a no-op.
      console.warn("[sync] cursor owner reset failed", err)
    }
  }

  /** Persist (and echo) the identity the cursor now belongs to. `origin` is the
   *  provenance to leave on record for it — `null` keeps whatever is stored. */
  async function recordOwner(
    userId: string,
    anonymous: boolean,
    storedAnon: string | null,
    origin: string | null,
    storedOrigin: string | null
  ): Promise<void> {
    const flag = anonymous ? ANON_FLAG : "0"
    await deps.app.preferences.set(CURSOR_OWNER_KEY, userId).catch(() => undefined)
    if (storedAnon !== flag) {
      await deps.app.preferences.set(CURSOR_OWNER_ANON_KEY, flag).catch(() => undefined)
    }
    if (origin !== null && origin !== storedOrigin) {
      await deps.app.preferences.set(CURSOR_OWNER_ORIGIN_KEY, origin).catch(() => undefined)
    }
    cursorOwnerId = userId
    cursorOwnerAnon = anonymous
  }

  /**
   * Provenance of an anonymous owner recorded before
   * {@link CURSOR_OWNER_ORIGIN_KEY} existed, or `null` when this device cannot
   * prove it. Without it every device already in the field fails
   * {@link ORIGIN_FIRST_RUN} and has its anonymous journal retired.
   *
   * {@link RETIRED_OUTBOX_KEY} cannot answer it alone: signing out wipes the
   * journal, so the switch reads a tail of 0. The per-account backfill marker
   * does survive a wipe, so one under any other id proves this device has
   * carried another identity. No evidence reads as not adoptable.
   */
  async function recoverFirstRunOrigin(stored: string): Promise<string | null> {
    const listKeys = deps.app.preferenceKeys
    if (!listKeys) return null
    // A switch that found a journal to retire: an identity did precede this one.
    if ((await readRetiredOutboxId()) > 0) return null
    let keys: readonly string[]
    try {
      keys = await listKeys()
    } catch {
      return null
    }
    const foreign = keys.some(
      (key) =>
        key.startsWith(BACKFILL_MARKER_PREFIX) &&
        key.slice(BACKFILL_MARKER_PREFIX.length) !== stored
    )
    if (foreign) return null
    // Persisted here: the same-account branch passes the origin through as-is.
    await deps.app.preferences.set(CURSOR_OWNER_ORIGIN_KEY, ORIGIN_FIRST_RUN).catch(() => undefined)
    return ORIGIN_FIRST_RUN
  }

  async function readRetiredOutboxId(): Promise<number> {
    const raw = await deps.app.preferences.get(RETIRED_OUTBOX_KEY).catch(() => null)
    const parsed = raw === null ? 0 : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  /** Never rewound — a wiped journal reports a tail of 0, and lowering the
   *  floor would re-expose a previous account's rows to a later handover. */
  async function raiseRetiredOutboxId(tail: number): Promise<void> {
    if (tail <= 0) return
    const current = await readRetiredOutboxId()
    if (tail <= current) return
    await deps.app.preferences.set(RETIRED_OUTBOX_KEY, String(tail)).catch(() => undefined)
  }

  return ensureCursorOwner
}
