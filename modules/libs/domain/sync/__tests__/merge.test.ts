import { describe, expect, it } from "vitest"
import { hlcToString } from "../hlc.js"
import { mergeListeningSession, mergeNote, mergePlaylistItem } from "../merge.js"
import type { PlaylistItemSyncData, SyncDoc } from "../types.js"

/** Build a wire HLC string with an explicit physical/counter/device. */
const hlc = (physical: number, counter = 0, deviceId = "a"): string =>
  hlcToString({ physical, counter, deviceId })

describe("mergeNote (LWW)", () => {
  const local: SyncDoc<{ text: string }> = {
    docId: "note_1",
    hlc: hlc(1000),
    deleted: false,
    data: { text: "local" },
  }
  const remote: SyncDoc<{ text: string }> = {
    docId: "note_1",
    hlc: hlc(2000),
    deleted: false,
    data: { text: "remote" },
  }

  it("keeps the higher-HLC version", () => {
    expect(mergeNote(local, remote)).toBe(remote)
    expect(mergeNote(remote, local)).toBe(remote)
  })

  it("is commutative in outcome", () => {
    expect(mergeNote(local, remote)).toEqual(mergeNote(remote, local))
  })

  it("is idempotent", () => {
    expect(mergeNote(remote, remote)).toEqual(remote)
  })

  it("lets a later delete beat an earlier edit", () => {
    const tombstone: SyncDoc<{ text: string }> = {
      docId: "note_1",
      hlc: hlc(3000),
      deleted: true,
      data: null,
    }
    expect(mergeNote(remote, tombstone)).toBe(tombstone)
  })
})

describe("mergeListeningSession (grow-only union)", () => {
  const session = (h: string): SyncDoc<{ toPosition: number }> => ({
    docId: "ls_1",
    hlc: h,
    deleted: false,
    data: { toPosition: 120 },
  })

  it("keeps a single deterministic version when both sides carry the id", () => {
    const a = session(hlc(1000, 0, "a"))
    const b = session(hlc(1000, 0, "b"))
    // Same payload (immutable), resolved deterministically by HLC tiebreak.
    expect(mergeListeningSession(a, b)).toBe(b)
    expect(mergeListeningSession(b, a)).toBe(b)
  })

  it("is idempotent", () => {
    const a = session(hlc(1000))
    expect(mergeListeningSession(a, a)).toEqual(a)
  })
})

describe("mergePlaylistItem (add-wins by track_id)", () => {
  const doc = (
    h: string,
    data: Partial<PlaylistItemSyncData> | null
  ): SyncDoc<PlaylistItemSyncData> => ({
    docId: "track-1",
    hlc: h,
    deleted: data === null,
    data:
      data === null
        ? null
        : { trackId: "track-1", addedAt: 0, archivedAt: null, collectionId: null, ...data },
  })

  it("add beats an older archive — item stays active", () => {
    const archived = doc(hlc(1000), { addedAt: 100, archivedAt: 500 })
    const readded = doc(hlc(2000), { addedAt: 900, archivedAt: null })
    const merged = mergePlaylistItem(archived, readded)
    expect(merged.data).toEqual({
      trackId: "track-1",
      addedAt: 900,
      archivedAt: null,
      collectionId: null,
    })
  })

  it("archive beats an older add — item is archived", () => {
    const added = doc(hlc(1000), { addedAt: 100, archivedAt: null })
    const archived = doc(hlc(2000), { addedAt: 100, archivedAt: 800 })
    const merged = mergePlaylistItem(added, archived)
    expect(merged.data?.archivedAt).toBe(800)
  })

  it("takes the newest add and newest archive independently", () => {
    const a = doc(hlc(1000), { addedAt: 300, archivedAt: 200 })
    const b = doc(hlc(2000), { addedAt: 100, archivedAt: 900 })
    const merged = mergePlaylistItem(a, b)
    // newest add = 300, newest archive = 900 → 900 > 300 → archived
    expect(merged.data).toMatchObject({ addedAt: 300, archivedAt: 900 })
  })

  it("carries the winning HLC and is commutative in outcome", () => {
    const a = doc(hlc(1000), { addedAt: 100 })
    const b = doc(hlc(2000), { addedAt: 900 })
    expect(mergePlaylistItem(a, b).hlc).toBe(hlc(2000))
    expect(mergePlaylistItem(a, b)).toEqual(mergePlaylistItem(b, a))
  })

  it("keeps non-null collection provenance", () => {
    const individual = doc(hlc(1000), { addedAt: 100, collectionId: null })
    const fromCollection = doc(hlc(2000), { addedAt: 900, collectionId: "col-9" })
    expect(mergePlaylistItem(individual, fromCollection).data?.collectionId).toBe("col-9")
  })

  it("falls back to the surviving side when one is a tombstone", () => {
    const alive = doc(hlc(1000), { addedAt: 100 })
    const tombstone = doc(hlc(2000), null)
    const merged = mergePlaylistItem(alive, tombstone)
    expect(merged.deleted).toBe(false)
    expect(merged.data?.addedAt).toBe(100)
    expect(merged.hlc).toBe(hlc(2000))
  })

  it("stays deleted when both sides are tombstones", () => {
    const merged = mergePlaylistItem(doc(hlc(1000), null), doc(hlc(2000), null))
    expect(merged.deleted).toBe(true)
    expect(merged.data).toBeNull()
  })
})
