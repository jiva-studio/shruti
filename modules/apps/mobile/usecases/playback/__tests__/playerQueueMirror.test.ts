import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaybackQueueItem, PlaybackQueueSnapshot } from "../playbackQueue.js"
import { createPlayerQueueMirror } from "../playerQueueMirror.js"

const A = "i-a" as PlaylistItemId
const B = "i-b" as PlaylistItemId
const C = "i-c" as PlaylistItemId

function item(itemId: string): PlaybackQueueItem {
  return { itemId, url: `file:///${itemId}.mp3`, title: itemId, author: "" }
}

const QUEUE = [item(A), item(B), item(C)]

let current: PlaylistItemId | null
let positionMs: number
let playing: boolean
let autoPlayNext: boolean
let engineState: PlaybackQueueSnapshot

const engine = {
  getQueueState: vi.fn(async () => engineState),
  setQueue: vi.fn<(items: PlaybackQueueItem[], start: number, at: number) => Promise<void>>(
    async () => {}
  ),
}
const playlist = {
  buildQueueFrom: vi.fn<
    (from: PlaylistItemId, lang?: LanguageCode) => Promise<PlaybackQueueItem[]>
  >(async () => QUEUE.slice()),
  resolveTrackForItemId: vi.fn(async (id: PlaylistItemId) => ({ id: `t-${id}` as TrackId })),
}
const downloads = {
  markEvictPending: vi.fn<(id: TrackId) => Promise<void>>(async () => {}),
  evict: vi.fn<(id: TrackId) => Promise<boolean>>(async () => true),
}
const reportError = vi.fn()

function mirror() {
  return createPlayerQueueMirror({
    identity: {
      itemId: () => current,
      positionMs: () => positionMs,
      playing: () => playing,
      language: () => null,
    },
    autoPlayNext: () => autoPlayNext,
    engine,
    playlist: () => playlist,
    downloads: () => downloads,
    reportError,
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  current = B
  positionMs = 1_000
  playing = true
  autoPlayNext = true
  engineState = { currentItemId: B, positionMs: 5_000, playing: true }
  vi.clearAllMocks()
})

describe("playerQueueMirror — the mirror", () => {
  it("is inactive until a queue is handed over, and forgets it on clear", async () => {
    const m = mirror()
    expect(m.isActive()).toBe(false)

    await m.handOver(QUEUE.slice(), 1, 0)
    expect(m.isActive()).toBe(true)
    expect(m.metaFor(C)).toEqual(item(C))
    expect(engine.setQueue).toHaveBeenCalledWith(QUEUE, 1, 0)

    m.clear()
    expect(m.isActive()).toBe(false)
    expect(m.metaFor(C)).toBeUndefined()
  })

  it("rebuilds from the playlist when it cannot place the current item", async () => {
    const m = mirror()
    await m.ensureMirror(B)

    expect(playlist.buildQueueFrom).toHaveBeenCalledWith(B, undefined)
    expect(m.metaFor(A)).toEqual(item(A))
  })

  it("reports a playlist that cannot be rebuilt and keeps the mirror it has", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    const boom = new Error("database is locked")
    playlist.buildQueueFrom.mockRejectedValueOnce(boom)

    await m.ensureMirror("i-elsewhere" as PlaylistItemId)

    expect(reportError).toHaveBeenCalledWith(boom)
    expect(m.metaFor(A)).toEqual(item(A))
  })

  it("does not rebuild a mirror that already places the current item", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    await m.ensureMirror(B)

    expect(playlist.buildQueueFrom).not.toHaveBeenCalled()
  })
})

describe("playerQueueMirror — push", () => {
  it("cannot rewrite from a mirror that does not place the current item", async () => {
    const m = mirror()
    current = "i-z" as PlaylistItemId

    expect(await m.push()).toBe(false)
    expect(engine.setQueue).not.toHaveBeenCalled()
  })

  it("restarts the current item at the engine's live position", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.setQueue.mockClear()

    expect(await m.push()).toBe(true)
    expect(engine.setQueue).toHaveBeenCalledWith(QUEUE, 1, 5_000)
  })

  it("falls back to the shown position when the engine is on another item", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engineState = { currentItemId: C, positionMs: 9_000, playing: true }

    await m.push()
    expect(engine.setQueue).toHaveBeenLastCalledWith(QUEUE, 1, 1_000)
  })

  it("restarts at the position of a snapshot it was handed, without asking the engine", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.getQueueState.mockClear()

    await m.push({ currentItemId: B, positionMs: 7_000, playing: true })

    expect(engine.getQueueState).not.toHaveBeenCalled()
    expect(engine.setQueue).toHaveBeenLastCalledWith(QUEUE, 1, 7_000)
  })

  it("reports an engine that cannot be read, then uses the shown position", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    const boom = new Error("bridge gone")
    engine.getQueueState.mockRejectedValueOnce(boom)

    await m.push()
    expect(engine.setQueue).toHaveBeenLastCalledWith(QUEUE, 1, 1_000)
    expect(reportError).toHaveBeenCalledWith(boom)
  })
})

describe("playerQueueMirror — dropping an archived item", () => {
  it("keeps the file of the item that is playing and remembers it", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)

    expect(await m.dropFromQueue(B)).toBe(true)
    await flush()
    expect(downloads.markEvictPending).toHaveBeenCalledWith("t-i-b")
  })

  it("rewrites the queue for an item ahead of a playing engine and frees its file", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.setQueue.mockClear()

    expect(await m.dropFromQueue(C)).toBe(false)
    expect(engine.setQueue).toHaveBeenCalledWith([item(A), item(B)], 1, 5_000)
    expect(m.metaFor(C)).toBeUndefined()
  })

  it("arms a rewrite instead of restarting a paused engine", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.setQueue.mockClear()
    engineState = { currentItemId: B, positionMs: 5_000, playing: false }

    expect(await m.dropFromQueue(C)).toBe(true)
    expect(engine.setQueue).not.toHaveBeenCalled()
    expect(m.needsRewrite()).toBe(true)
  })

  it("keeps the file of an item behind the playhead without arming a rewrite", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.setQueue.mockClear()

    expect(await m.dropFromQueue(A)).toBe(true)
    expect(engine.setQueue).not.toHaveBeenCalled()
    expect(m.needsRewrite()).toBe(false)
  })

  it("frees a kept file on the next rewrite that lands", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    await m.dropFromQueue(A)
    await flush()
    expect(downloads.evict).not.toHaveBeenCalled()

    await m.push()
    expect(downloads.evict).toHaveBeenCalledWith("t-i-a")
  })

  it("answers false for an item the mirror does not hold", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)

    expect(await m.dropFromQueue("i-z" as PlaylistItemId)).toBe(false)
  })

  it("reports an engine that cannot be read, then treats it as paused", async () => {
    const m = mirror()
    await m.handOver(QUEUE.slice(), 1, 0)
    engine.setQueue.mockClear()
    playing = false
    const boom = new Error("bridge gone")
    engine.getQueueState.mockRejectedValueOnce(boom)

    expect(await m.dropFromQueue(C)).toBe(true)
    expect(engine.setQueue).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(boom)
  })
})

describe("playerQueueMirror — a late entitlement", () => {
  it("hands the playlist tail over to a playing single-track engine", async () => {
    const m = mirror()

    await m.armForEntitlement()
    expect(m.isActive()).toBe(true)
    expect(engine.setQueue).toHaveBeenCalledWith(QUEUE, 1, 5_000)
  })

  it("arms a rewrite for a paused engine instead of starting playback", async () => {
    const m = mirror()
    engineState = { currentItemId: B, positionMs: 5_000, playing: false }

    await m.armForEntitlement()
    expect(engine.setQueue).not.toHaveBeenCalled()
    expect(m.needsRewrite()).toBe(true)
  })

  it("leaves an engine that moved on to something else alone", async () => {
    const m = mirror()
    engineState = { currentItemId: C, positionMs: 0, playing: true }

    await m.armForEntitlement()
    expect(m.isActive()).toBe(false)
    expect(engine.setQueue).not.toHaveBeenCalled()
  })

  it("does nothing while continuous playback is off", async () => {
    const m = mirror()
    autoPlayNext = false

    await m.armForEntitlement()
    expect(playlist.buildQueueFrom).not.toHaveBeenCalled()
  })

  it("does nothing for a tail of one", async () => {
    const m = mirror()
    playlist.buildQueueFrom.mockResolvedValueOnce([item(B)])

    await m.armForEntitlement()
    expect(m.isActive()).toBe(false)
  })

  it("reports an engine that cannot be read", async () => {
    const m = mirror()
    const boom = new Error("bridge gone")
    engine.getQueueState.mockRejectedValueOnce(boom)

    await m.armForEntitlement()
    expect(reportError).toHaveBeenCalledWith(boom)
  })
})
