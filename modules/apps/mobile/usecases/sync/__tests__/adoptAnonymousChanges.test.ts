import { describe, expect, it } from "vitest"
import { adoptAnonymousChanges } from "../adoptAnonymousChanges.js"
import { FakeApply, FakeOutbox, fakeUnitOfWork, hlc } from "./fakes.js"

/**
 * Unit tests for the anonymous → signed-in handover (#1627). The scope
 * predicate is the whole point: it has to take everything the anonymous
 * identity could push (its own rows AND the unstamped ones a pre-023 journal
 * left behind) and nothing that belongs to an account before it.
 */
function seed() {
  const outbox = new FakeOutbox()
  const apply = new FakeApply()
  return { outbox, apply, unitOfWork: fakeUnitOfWork }
}

function entry(docId: string, h: number) {
  return {
    collection: "notes",
    docId,
    op: "upsert" as const,
    data: { id: docId },
    hlc: hlc(h),
    baseHlc: null,
  }
}

describe("adoptAnonymousChanges", () => {
  it("hands the anonymous journal to the account that signed in", async () => {
    const d = seed()
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n1", 1000), entry("n2", 2000)])
    await d.outbox.markSent([1]) // n1 already reached the anonymous account
    d.apply.setServerHlc("notes", "n1", hlc(1000))

    const res = await adoptAnonymousChanges({
      ...d,
      fromOwnerId: "anon-1",
      toOwnerId: "user-b",
    })

    expect(res.docs).toBe(2)
    // Both rows are pending again, under the new owner, keeping their HLCs.
    const pending = await d.outbox.listPending(undefined, { ownerId: "user-b" })
    expect(pending.map((p) => p.docId)).toEqual(["n1", "n2"])
    expect(pending.map((p) => p.hlc)).toEqual([hlc(1000), hlc(2000)])
    // The pointer named a master in the account left behind.
    expect(await d.apply.lastServerHlc("notes", "n1")).toBeNull()
  })

  it("marks the handed-over rows as descending from nothing the new account has", async () => {
    const d = seed()
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n1", 1000)])

    await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "user-b" })

    const [row] = await d.outbox.listPending(undefined, { ownerId: "user-b" })
    expect(row!.baseHlc).toBe("")
  })

  it("takes the unstamped rows a pre-023 journal left behind", async () => {
    const d = seed()
    d.outbox.owner = null
    d.outbox.seed([entry("n1", 1000)])

    const res = await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "user-b" })

    expect(res.docs).toBe(1)
    expect(await d.outbox.listPending(undefined, { ownerId: "user-b" })).toHaveLength(1)
  })

  it("leaves unstamped rows an earlier identity change retired", async () => {
    const d = seed()
    d.outbox.owner = null
    d.outbox.seed([entry("n1", 1000), entry("n2", 2000)]) // ids 1, 2 — retired
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n3", 3000)])

    const res = await adoptAnonymousChanges({
      ...d,
      fromOwnerId: "anon-1",
      toOwnerId: "user-b",
      unownedAfterId: 2,
    })

    expect(res.docs).toBe(1)
    expect(d.outbox.rows.map((r) => r.owner)).toEqual([null, null, "user-b"])
  })

  it("never touches another account's rows", async () => {
    const d = seed()
    d.outbox.owner = "user-c"
    d.outbox.seed([entry("n1", 1000)])
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n2", 2000)])

    await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "user-b" })

    expect(d.outbox.rows.find((r) => r.docId === "n1")!.owner).toBe("user-c")
  })

  it("does nothing when the anonymous id was upgraded in place", async () => {
    const d = seed()
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n1", 1000)])
    await d.outbox.markSent([1])
    d.apply.setServerHlc("notes", "n1", hlc(1000))

    const res = await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "anon-1" })

    expect(res.docs).toBe(0)
    expect(d.outbox.rows[0]!.sent).toBe(true)
    expect(await d.apply.lastServerHlc("notes", "n1")).toBe(hlc(1000))
  })

  it("is a no-op on a re-run, and keeps the pointers the push recorded since", async () => {
    const d = seed()
    d.outbox.owner = "anon-1"
    d.outbox.seed([entry("n1", 1000)])

    await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "user-b" })
    // The push landed the row under the new account before the interruption.
    await d.outbox.markSent([1])
    d.apply.setServerHlc("notes", "n1", hlc(1000))

    const again = await adoptAnonymousChanges({ ...d, fromOwnerId: "anon-1", toOwnerId: "user-b" })

    expect(again.docs).toBe(0)
    expect(d.outbox.rows[0]!.sent).toBe(true)
    expect(await d.apply.lastServerHlc("notes", "n1")).toBe(hlc(1000))
  })
})
