import { describe, expect, it } from "vitest"
import type { OutboxEntry } from "@lib/domain/ports/outboxRepository.js"
import { higherHlc, latestPendingForKey, refKey, settlePushedRows } from "../pushSettlement.js"

function entry(id: number, docId: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id,
    collection: "notes",
    docId,
    op: "upsert",
    data: {},
    hlc: `hlc-${id}`,
    baseHlc: null,
    ...over,
  }
}

const keys = (...refs: [string, string][]) => new Set(refs.map(([c, d]) => refKey(c, d)))

describe("settlePushedRows", () => {
  it("reports an applied row for its server-master record", () => {
    const rows = [entry(1, "a")]
    const settled = settlePushedRows(rows, keys(["notes", "a"]), new Set())
    expect(settled.applied).toEqual(rows)
    expect(settled.sentIds).toEqual([1])
    expect(settled.maxSentId).toBe(1)
  })

  it("marks a conflicted row sent without recording it as applied", () => {
    const settled = settlePushedRows([entry(1, "a")], new Set(), keys(["notes", "a"]))
    expect(settled.applied).toEqual([])
    expect(settled.sentIds).toEqual([1])
  })

  it("leaves a row the server said nothing about pending", () => {
    const settled = settlePushedRows([entry(1, "a")], new Set(), new Set())
    expect(settled.sentIds).toEqual([])
    expect(settled.maxSentId).toBe(0)
  })

  it("stops the watermark at the first unhandled row, so nothing is retired unpushed", () => {
    const rows = [entry(1, "a"), entry(2, "b"), entry(3, "c")]
    const settled = settlePushedRows(rows, keys(["notes", "a"], ["notes", "c"]), new Set())
    expect(settled.sentIds).toEqual([1, 3])
    expect(settled.maxSentId).toBe(1)
  })

  it("names each acknowledged document once, however many rows it had", () => {
    const rows = [entry(1, "a"), entry(2, "a")]
    const settled = settlePushedRows(rows, keys(["notes", "a"]), new Set())
    expect(settled.sentDocs).toEqual([{ collection: "notes", docId: "a" }])
  })

  it("has nothing to settle for an empty batch", () => {
    expect(settlePushedRows([], new Set(), new Set())).toEqual({
      applied: [],
      sentIds: [],
      sentDocs: [],
      maxSentId: 0,
    })
  })
})

describe("latestPendingForKey", () => {
  it("takes the highest-id row of that document", () => {
    const rows = [entry(1, "a"), entry(5, "a"), entry(3, "a"), entry(9, "b")]
    expect(latestPendingForKey(rows, refKey("notes", "a"))?.id).toBe(5)
  })

  it("finds nothing for a document that is not pending", () => {
    expect(latestPendingForKey([entry(1, "a")], refKey("notes", "z"))).toBeUndefined()
  })

  it("keeps documents of different collections apart", () => {
    const rows = [entry(1, "a", { collection: "notes" }), entry(2, "a", { collection: "tags" })]
    expect(latestPendingForKey(rows, refKey("tags", "a"))?.id).toBe(2)
  })
})

describe("higherHlc", () => {
  it("takes the master when this device has no clock tail", () => {
    expect(higherHlc(null, "1000:0:dev")).toBe("1000:0:dev")
  })

  it("takes whichever of the two is higher", () => {
    expect(higherHlc("2000:0:dev", "1000:0:dev")).toBe("2000:0:dev")
    expect(higherHlc("1000:0:dev", "2000:0:dev")).toBe("2000:0:dev")
  })

  it("keeps ours on a tie, so the seed never goes backwards", () => {
    expect(higherHlc("1000:0:dev", "1000:0:dev")).toBe("1000:0:dev")
  })
})
