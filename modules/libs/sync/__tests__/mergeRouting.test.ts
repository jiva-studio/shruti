import { describe, expect, it } from "vitest"
import { hlcToString } from "@lib/domain/sync/hlc.js"
import {
  changeToDoc,
  isChatCollection,
  isSyncedCollection,
  mergeChange,
  pendingToDoc,
} from "../mergeRouting.js"

const at = (physical: number, deviceId = "dev") => hlcToString({ physical, counter: 0, deviceId })

describe("pendingToDoc / changeToDoc", () => {
  it("read a pending write and a pulled change as the same document shape", () => {
    expect(pendingToDoc({ docId: "s1", op: "upsert", data: { title: "t" }, hlc: at(1) })).toEqual({
      docId: "s1",
      hlc: at(1),
      deleted: false,
      data: { title: "t" },
    })
    expect(
      changeToDoc({ collection: "chat_sessions", doc_id: "s1", op: "delete", hlc: at(2) })
    ).toEqual({ docId: "s1", hlc: at(2), deleted: true, data: null })
  })
})

describe("mergeChange", () => {
  it("keeps the newer chat write, local or remote", () => {
    const local = pendingToDoc({ docId: "s1", op: "upsert", data: { v: 1 }, hlc: at(5) })
    const older = changeToDoc({
      collection: "chat_sessions",
      doc_id: "s1",
      op: "upsert",
      hlc: at(4),
    })
    const newer = changeToDoc({
      collection: "chat_sessions",
      doc_id: "s1",
      op: "upsert",
      hlc: at(6),
    })
    expect(mergeChange("chat_sessions", local, older)).toBe(local)
    expect(mergeChange("chat_messages", local, newer)).toBe(newer)
  })
})

describe("collection routing", () => {
  it("knows the synced and the chat collections", () => {
    expect(isSyncedCollection("chat_messages")).toBe(true)
    expect(isSyncedCollection("future_thing")).toBe(false)
    expect(isChatCollection("chat_sessions")).toBe(true)
    expect(isChatCollection("notes")).toBe(false)
  })
})
