import { describe, expect, it } from "vitest"
import { toPushItem } from "../pushItem.js"

describe("toPushItem", () => {
  it("carries an upsert's row and the base it was made against", () => {
    expect(
      toPushItem(
        { collection: "notes", docId: "n1", op: "upsert", data: { text: "x" }, hlc: "h2" },
        "h1"
      )
    ).toEqual({
      collection: "notes",
      doc_id: "n1",
      op: "upsert",
      data: { text: "x" },
      hlc: "h2",
      base_hlc: "h1",
    })
  })

  it("sends no row for a delete", () => {
    const item = toPushItem(
      { collection: "chat_sessions", docId: "s1", op: "delete", data: null, hlc: "h3" },
      ""
    )
    expect(JSON.parse(JSON.stringify(item))).toEqual({
      collection: "chat_sessions",
      doc_id: "s1",
      op: "delete",
      hlc: "h3",
      base_hlc: "",
    })
  })
})
