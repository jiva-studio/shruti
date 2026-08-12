// @vitest-environment jsdom
import { createApp, reactive, ref } from "vue"
import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * Behavioural test for the Lane E2b wiring in `useSyncEngine`: the engine stays
 * dark until a user identity exists, then runs for ANY identity — anonymous
 * device accounts included, so their data reaches the server even without a
 * sign-in. It runs the first-sync backfill exactly once per account (guarded by
 * the device-local marker) and always backfills *before* it pushes.
 *
 * Everything the composable pulls in (use cases, the Shruti singleton, the
 * Pinia stores, the Capacitor App listener, the sync-event bus) is mocked
 * through a hoisted context object so the factories are initialised before the
 * composable's module graph loads.
 */
const ctx = vi.hoisted(() => ({
  auth: null as { signedIn: boolean; userId: string | null; anonymous: boolean } | null,
  shruti: null as unknown,
  adoptAnonymousChanges: null as unknown as ReturnType<typeof vi.fn>,
  backfillLocal: null as unknown as ReturnType<typeof vi.fn>,
  runSync: null as unknown as ReturnType<typeof vi.fn>,
  resumeCb: null as null | ((s: { isActive: boolean }) => void),
}))

vi.mock("@usecases/sync/index.js", () => ({
  adoptAnonymousChanges: (...a: unknown[]) =>
    (ctx.adoptAnonymousChanges as unknown as (...x: unknown[]) => unknown)(...a),
  backfillLocal: (...a: unknown[]) =>
    (ctx.backfillLocal as unknown as (...x: unknown[]) => unknown)(...a),
  runSync: (...a: unknown[]) => (ctx.runSync as unknown as (...x: unknown[]) => unknown)(...a),
  // Personal-library poll cadence (#1229). Kept idle here so the self-
  // rescheduling poll never fires a second cycle during these microtask flushes.
  hasPendingLibraryItems: () => false,
  nextSyncDelayMs: () => 3 * 60 * 1000,
}))
vi.mock("@shruti/shruti.js", () => ({ useShruti: () => ctx.shruti }))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useAuthStore.js", () => ({ useAuthStore: () => ctx.auth }))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({
  useChatStore: () => ({ refreshSessions: async () => {} }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ onSyncEvent: () => () => {} }))
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_evt: string, cb: (s: { isActive: boolean }) => void) => {
      ctx.resumeCb = cb
      return { remove: async () => {} }
    },
  },
}))

import { useSyncEngine } from "../useSyncEngine.js"

/** Drain the microtask queue so the void-ed async `sync()` cycles settle. The
 *  count only has to exceed the awaits one cycle chains through. */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

/** Mount a throwaway component whose only job is to run the composable, so its
 *  `onMounted` / watchers fire under a real component instance. */
function mountEngine() {
  const app = createApp({
    setup() {
      useSyncEngine()
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return app
}

let prefs: Map<string, string>

beforeEach(() => {
  prefs = new Map()
  ctx.auth = reactive({ signedIn: false, userId: null, anonymous: true })
  ctx.resumeCb = null
  ctx.adoptAnonymousChanges = vi.fn(async () => ({ docs: 3 }))
  ctx.backfillLocal = vi.fn(async () => ({ enqueued: 2, collections: ["notes"] }))
  ctx.runSync = vi.fn(async () => ({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 }))
  ctx.shruti = {
    activeServer: ref({ profileBaseUrl: "https://profile.example" }),
    syncClient: {},
    preferences: {
      get: async (k: string) => prefs.get(k) ?? null,
      set: async (k: string, v: string) => {
        prefs.set(k, v)
      },
    },
    repositories: () => ({
      syncBackfill: {},
      syncOutbox: {},
      syncState: {},
      syncApply: {},
      unitOfWork: {},
      libraryItems: { listAll: async () => [] },
    }),
  }
})

describe("useSyncEngine — first-sync backfill", () => {
  it("stays dark until an identity exists (no userId yet)", async () => {
    const app = mountEngine()
    await flush()

    expect(ctx.backfillLocal).not.toHaveBeenCalled()
    expect(ctx.runSync).not.toHaveBeenCalled()
    app.unmount()
  })

  it("syncs for an anonymous identity (userId set, never signed in)", async () => {
    const app = mountEngine()
    await flush()

    // Anonymous bootstrap resolves: a userId appears while signedIn stays false.
    ctx.auth!.userId = "anon-1"
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    expect(prefs.get("sync.backfilled.anon-1")).toBe("1")
    app.unmount()
  })

  it("on sign-in, backfills once (before pushing) and persists the per-account marker", async () => {
    const app = mountEngine()
    await flush()

    // Anonymous → real account on the same device (Upgrade-in-place).
    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    // Backfill runs strictly before the push cycle.
    expect(ctx.backfillLocal.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    // Marker written under the account id.
    expect(prefs.get("sync.backfilled.user-1")).toBe("1")
    app.unmount()
  })

  it("runs the backfill at most once per account across later cycles", async () => {
    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()
    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)

    // A later foreground-resume cycle must NOT re-run the backfill.
    ctx.resumeCb?.({ isActive: true })
    await flush()

    expect(ctx.backfillLocal).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(2)
    app.unmount()
  })

  it("skips the backfill when the account was already backfilled on this device", async () => {
    prefs.set("sync.backfilled.user-2", "1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.backfillLocal).not.toHaveBeenCalled()
    // …but the normal sync cycle still runs.
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})

describe("useSyncEngine — cursor-ownership reset", () => {
  let setPullCursor: ReturnType<typeof vi.fn>
  let setAckedSeq: ReturnType<typeof vi.fn>
  let setPushedOutboxId: ReturnType<typeof vi.fn>
  /** Where the watermark already sits when the guard runs. */
  let pushedOutboxId: number

  beforeEach(() => {
    setPullCursor = vi.fn(async () => {})
    setAckedSeq = vi.fn(async () => {})
    setPushedOutboxId = vi.fn(async () => {})
    pushedOutboxId = 0
    // Swap in a syncState that records the reset writes and a unit-of-work that
    // actually invokes its callback (the default mocks are opaque `{}`).
    // The outbox holds 7 rows journaled by whoever owned the device before.
    ;(ctx.shruti as { repositories: () => unknown }).repositories = () => ({
      syncBackfill: {},
      syncOutbox: { latestId: async () => 7 },
      syncState: {
        setPullCursor,
        setAckedSeq,
        setPushedOutboxId,
        getPushedOutboxId: async () => pushedOutboxId,
      },
      syncApply: {},
      unitOfWork: { run: (fn: () => unknown) => fn() },
      libraryItems: { listAll: async () => [] },
    })
  })

  it("resets pull_cursor + acked_seq when a different account signs in on this device", async () => {
    // A prior account already owns the cursor on this device.
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-2"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).toHaveBeenCalledWith(0)
    expect(setAckedSeq).toHaveBeenCalledWith(0)
    // Ownership now records the new account, and the reset precedes the pull.
    expect(prefs.get("sync.cursorOwner")).toBe("user-2")
    expect(setPullCursor.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    app.unmount()
  })

  it("does NOT reset when the same account re-signs in (owner unchanged)", async () => {
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).not.toHaveBeenCalled()
    expect(setAckedSeq).not.toHaveBeenCalled()
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    app.unmount()
  })

  it("first-ever owner records ownership without touching the (already-zero) cursor", async () => {
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-1"
    ctx.auth!.signedIn = true
    await flush()

    expect(setPullCursor).not.toHaveBeenCalled()
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    expect(prefs.get("sync.cursorOwner")).toBe("user-1")
    app.unmount()
  })

  it("retires the previous owner's outbox rows before the new identity pushes", async () => {
    // Account deleted with un-pushed rows still journaled; the wipe leaves them
    // behind and the device drops to a fresh anonymous identity (#1497).
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()

    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    expect(setPushedOutboxId.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    app.unmount()
  })

  it("scopes the drain to the account that owns the device now", async () => {
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()

    expect(ctx.runSync.mock.calls[0]![0]).toMatchObject({ ownerId: "anon-2" })
    app.unmount()
  })

  it("still scopes the drain when the identity changes mid-cycle", async () => {
    // A cycle for user-1 is in flight when the account is deleted, so the
    // watch-triggered sync is swallowed by the single-flight guard and the
    // owner reset does not run until a later cycle — by which point anon-2 has
    // journaled rows of its own. `ownerId` is what keeps those rows pushable;
    // the watermark, stamped late at the journal's tail, cannot be trusted.
    prefs.set("sync.cursorOwner", "user-1")
    let releaseCycle: () => void = () => {}
    ctx.runSync = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseCycle = () => resolve({ skipped: false, pulled: 0, pushed: 0, conflicts: 0 })
        })
    )

    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-1"
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)
    expect(setPushedOutboxId).not.toHaveBeenCalled()

    // Account deleted mid-cycle: the new identity's sync trigger is dropped.
    ctx.auth!.userId = "anon-2"
    ctx.auth!.signedIn = false
    await flush()
    expect(ctx.runSync).toHaveBeenCalledTimes(1)

    releaseCycle()
    await flush()
    ctx.resumeCb?.({ isActive: true })
    await flush()

    // The late reset lands, and the cycle it precedes drains as anon-2.
    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    expect(ctx.runSync.mock.calls[1]![0]).toMatchObject({ ownerId: "anon-2" })
    app.unmount()
  })

  it("never rewinds the watermark to a shorter journal", async () => {
    // A pruned or restored user.db has a tail below the current mark. Writing
    // it would un-retire the previous account's unowned rows — #1497 again.
    pushedOutboxId = 50
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()

    expect(setPullCursor).toHaveBeenCalledWith(0)
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    app.unmount()
  })

  it("stamps the watermark once per switch, not on every later cycle", async () => {
    prefs.set("sync.cursorOwner", "user-1")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()
    ctx.resumeCb?.({ isActive: true })
    await flush()

    expect(setPushedOutboxId).toHaveBeenCalledTimes(1)
    expect(ctx.runSync).toHaveBeenCalledTimes(2)
    app.unmount()
  })
})

/**
 * The anonymous → pre-existing-account transition (#1627). Sign-in keeps the
 * anonymous id only when the human had no account yet; a returning one lands on
 * a DIFFERENT id, and retiring the journal there strands the whole anonymous
 * period on an account nobody can reach. The engine has to tell the two apart
 * from the marker it wrote for the previous identity.
 *
 * …and only an anonymous session nobody ever claimed may be handed over
 * (#1774): after a sign-out the device is anonymous again, so the next person
 * to use the phone writes under an anonymous id too. The fixture below is a
 * first-run session; the tests that follow it change the provenance.
 */
describe("useSyncEngine — anonymous handover", () => {
  let setPushedOutboxId: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setPushedOutboxId = vi.fn(async () => {})
    ;(ctx.shruti as { repositories: () => unknown }).repositories = () => ({
      syncBackfill: {},
      syncOutbox: { latestId: async () => 7 },
      syncState: {
        setPullCursor: async () => {},
        setAckedSeq: async () => {},
        setPushedOutboxId,
        getPushedOutboxId: async () => 0,
      },
      syncApply: {},
      unitOfWork: { run: (fn: () => unknown) => fn() },
      libraryItems: { listAll: async () => [] },
    })
    prefs.set("sync.cursorOwner", "anon-1")
    prefs.set("sync.cursorOwnerAnon", "1")
    prefs.set("sync.cursorOwnerOrigin", "first-run")
  })

  it("hands the anonymous journal over instead of retiring it", async () => {
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.adoptAnonymousChanges).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwnerId: "anon-1", toOwnerId: "user-b", unownedAfterId: 0 })
    )
    // Retiring is the opposite of handing over — the watermark stays put.
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    // …and it lands before the cycle that pushes.
    expect(ctx.adoptAnonymousChanges.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.runSync.mock.invocationCallOrder[0]
    )
    app.unmount()
  })

  it("leaves behind the rows an earlier identity change retired", async () => {
    prefs.set("sync.retiredOutboxId", "4")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    await flush()

    expect(ctx.adoptAnonymousChanges).toHaveBeenCalledWith(
      expect.objectContaining({ unownedAfterId: 4 })
    )
    app.unmount()
  })

  it("retires, and records the floor, when the previous owner was signed in", async () => {
    prefs.set("sync.cursorOwnerAnon", "0")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    expect(prefs.get("sync.retiredOutboxId")).toBe("7")
    app.unmount()
  })

  it("does not hand over when the previous owner's anonymity is unknown", async () => {
    // A device upgrading from a build that never wrote the flag.
    prefs.delete("sync.cursorOwnerAnon")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    app.unmount()
  })

  it("refuses the handover for an anonymous session created by a sign-out", async () => {
    // Person A signed out, person B has been using the phone since. The rows
    // journaled under `anon-1` are B's, and A signing back in must not collect
    // them (#1774).
    prefs.set("sync.cursorOwnerOrigin", "replaced")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    // Retired like any other identity switch, so B's rows never push under A.
    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    expect(prefs.get("sync.retiredOutboxId")).toBe("7")
    app.unmount()
  })

  it("refuses the handover when the anonymous session's origin is unknown", async () => {
    // A device that upgraded to this build mid-session: the marker was never
    // written, so nothing proves the session was never claimed. Not adopting
    // leaves the rows on the device; adopting could publish a stranger's.
    prefs.delete("sync.cursorOwnerOrigin")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    expect(setPushedOutboxId).toHaveBeenCalledWith(7)
    app.unmount()
  })

  it("records a first-run origin for the very first identity on the device", async () => {
    prefs.delete("sync.cursorOwner")
    prefs.delete("sync.cursorOwnerAnon")
    prefs.delete("sync.cursorOwnerOrigin")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-1"
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBe("first-run")
    app.unmount()
  })

  it("records a replaced origin for the anonymous identity a sign-out mints", async () => {
    prefs.set("sync.cursorOwner", "user-a")
    prefs.set("sync.cursorOwnerAnon", "0")
    prefs.delete("sync.cursorOwnerOrigin")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-2"
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBe("replaced")
    app.unmount()
  })

  it("does not adopt the data written between a sign-out and the same account signing back in", async () => {
    // The whole sequence in one run: A signs out, B uses the phone anonymously,
    // A signs back in.
    prefs.set("sync.cursorOwner", "user-a")
    prefs.set("sync.cursorOwnerAnon", "0")
    prefs.delete("sync.cursorOwnerOrigin")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-b"
    ctx.auth!.anonymous = true
    ctx.auth!.signedIn = false
    await flush()

    ctx.auth!.userId = "user-a"
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    app.unmount()
  })

  it("leaves an unknown origin unknown while the identity does not change", async () => {
    // Same anonymous account across the upgrade: its birth was never observed,
    // and inventing "first-run" here would be inventing the absence of a
    // sign-out.
    prefs.delete("sync.cursorOwnerOrigin")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-1"
    await flush()

    expect(prefs.get("sync.cursorOwnerOrigin")).toBeUndefined()
    app.unmount()
  })

  it("records the anonymity of the identity it observes, not only on a change", async () => {
    // Same device, same account, first cycle of the fixed build: stamping the
    // flag now is what makes a LATER sign-in recognisable as a handover.
    prefs.delete("sync.cursorOwnerAnon")
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-1"
    await flush()

    expect(prefs.get("sync.cursorOwnerAnon")).toBe("1")
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    app.unmount()
  })

  it("treats an in-place upgrade as no transition at all", async () => {
    // The third sign-in branch: the anonymous account itself is claimed, so the
    // id the server knows never changes and nothing is stranded.
    const app = mountEngine()
    await flush()

    ctx.auth!.userId = "anon-1"
    ctx.auth!.anonymous = false
    ctx.auth!.signedIn = true
    await flush()

    expect(ctx.adoptAnonymousChanges).not.toHaveBeenCalled()
    expect(setPushedOutboxId).not.toHaveBeenCalled()
    expect(prefs.get("sync.cursorOwnerAnon")).toBe("0")
    app.unmount()
  })

  it("re-runs the handover when the marker never landed", async () => {
    const app = mountEngine()
    await flush()
    ctx.auth!.userId = "user-b"
    ctx.auth!.anonymous = false
    await flush()
    expect(ctx.adoptAnonymousChanges).toHaveBeenCalledTimes(1)

    // Killed between the transaction and the marker write, then relaunched:
    // the transition is still visible, and the use case is a no-op the second
    // time round.
    prefs.set("sync.cursorOwner", "anon-1")
    prefs.set("sync.cursorOwnerAnon", "1")
    app.unmount()
    const relaunched = mountEngine()
    await flush()

    expect(ctx.adoptAnonymousChanges).toHaveBeenCalledTimes(2)
    relaunched.unmount()
  })
})
