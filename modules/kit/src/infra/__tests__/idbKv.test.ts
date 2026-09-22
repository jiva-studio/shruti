import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import {
  saveData,
  saveBlob,
  getBlob,
  deleteBlob,
  keyExists,
  getAllKeys,
  getStorageInfo,
} from "../idbKv.js"

const DB = "test-db"
const STORE = "blobs"

// fake-indexeddb structured-clones stored values, so the readback is a
// cross-realm Uint8Array that `toEqual` won't match by prototype. Compare the
// raw byte contents instead.
const bytes = (u: Uint8Array | null): number[] | null => (u === null ? null : Array.from(u))

describe("idbKv", () => {
  beforeEach(() => {
    // Fresh IndexedDB per test.
    globalThis.indexedDB = new IDBFactory()
  })

  it("saves and reads back raw bytes, creating the db/store on demand", async () => {
    const data = new Uint8Array([1, 2, 3, 4])
    await saveData(DB, STORE, "k", data)
    const out = await getBlob(DB, STORE, "k")
    expect(bytes(out)).toEqual([1, 2, 3, 4])
  })

  it("returns null for a missing key", async () => {
    await saveData(DB, STORE, "present", new Uint8Array([9]))
    expect(await getBlob(DB, STORE, "absent")).toBeNull()
  })

  it("overwrites an existing value", async () => {
    await saveData(DB, STORE, "k", new Uint8Array([1]))
    await saveData(DB, STORE, "k", new Uint8Array([2, 2]))
    expect(bytes(await getBlob(DB, STORE, "k"))).toEqual([2, 2])
  })

  it("saveBlob stores a Blob's bytes", async () => {
    const blob = new Blob([new Uint8Array([7, 8, 9])])
    await saveBlob(DB, STORE, "b", blob)
    expect(bytes(await getBlob(DB, STORE, "b"))).toEqual([7, 8, 9])
  })

  it("keyExists reflects presence, and is false on a never-created db", async () => {
    expect(await keyExists("never-created", STORE, "x")).toBe(false)
    await saveData(DB, STORE, "x", new Uint8Array([0]))
    expect(await keyExists(DB, STORE, "x")).toBe(true)
    expect(await keyExists(DB, STORE, "y")).toBe(false)
  })

  it("deleteBlob removes a value", async () => {
    await saveData(DB, STORE, "k", new Uint8Array([1]))
    await deleteBlob(DB, STORE, "k")
    expect(await keyExists(DB, STORE, "k")).toBe(false)
  })

  it("getAllKeys and getStorageInfo report stored keys", async () => {
    await saveData(DB, STORE, "a", new Uint8Array([1]))
    await saveData(DB, STORE, "b", new Uint8Array([2]))
    const keys = await getAllKeys(DB, STORE)
    expect(keys.sort()).toEqual(["a", "b"])
    expect(await getStorageInfo(DB, STORE)).toEqual({ keyCount: 2 })
  })

  it("ensures a new store on an existing db via version bump", async () => {
    await saveData(DB, "store-one", "k", new Uint8Array([1]))
    // Different store on the same db forces the upgrade path.
    await saveData(DB, "store-two", "k", new Uint8Array([2]))
    expect(bytes(await getBlob(DB, "store-one", "k"))).toEqual([1])
    expect(bytes(await getBlob(DB, "store-two", "k"))).toEqual([2])
  })
})
