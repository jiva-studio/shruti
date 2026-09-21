import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PositionJump, QueueTransition } from "@shruti/plugin-audio-player"

/**
 * The plugin speaks seconds and the `IAudioPlayer` contract milliseconds, so
 * this adapter is the one place a factor of 1000 can go missing.
 */

type JumpCallback = (jump: PositionJump) => void
type TransitionCallback = (t: QueueTransition) => void

let jumpCallbacks: JumpCallback[] = []
let transitionCallbacks: TransitionCallback[] = []

const seekMock = vi.fn<(a: { position: number }) => Promise<void>>(async () => {})
const seekByMock = vi.fn<(a: { delta: number }) => Promise<void>>(async () => {})
const setMixMock = vi.fn<(a: { enabled: boolean; ratio: number }) => Promise<void>>(async () => {})
const setPlaybackRateMock = vi.fn<(a: { rate: number }) => Promise<void>>(async () => {})
const setProgressIntervalMock = vi.fn<(a: { intervalMs: number }) => Promise<void>>(async () => {})
const setQueueMock = vi.fn<(a: unknown) => Promise<void>>(async () => {})
const appendToQueueMock = vi.fn<(a: unknown) => Promise<void>>(async () => {})
const getQueueStateMock = vi.fn()
const ackEventsMock = vi.fn<(a: { upToSeq: number }) => Promise<void>>(async () => {})
const simpleMocks = {
  play: vi.fn(async () => {}),
  togglePause: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  skipToNext: vi.fn(async () => {}),
  skipToPrevious: vi.fn(async () => {}),
  open: vi.fn<(a: unknown) => Promise<void>>(async () => {}),
}

vi.mock("@shruti/plugin-audio-player", () => ({
  AudioPlayer: {
    onProgressChanged: async () => ({ callbackId: "progress" }),
    onPositionJump: async (cb: JumpCallback) => {
      jumpCallbacks.push(cb)
      return { callbackId: "jump" }
    },
    onItemTransition: async (cb: TransitionCallback) => {
      transitionCallbacks.push(cb)
      return { callbackId: "transition" }
    },
    open: (a: unknown) => simpleMocks.open(a),
    play: () => simpleMocks.play(),
    togglePause: () => simpleMocks.togglePause(),
    stop: () => simpleMocks.stop(),
    skipToNext: () => simpleMocks.skipToNext(),
    skipToPrevious: () => simpleMocks.skipToPrevious(),
    seek: (a: never) => seekMock(a),
    seekBy: (a: never) => seekByMock(a),
    setMix: (a: never) => setMixMock(a),
    setPlaybackRate: (a: never) => setPlaybackRateMock(a),
    setProgressInterval: (a: never) => setProgressIntervalMock(a),
    setQueue: (a: unknown) => setQueueMock(a),
    appendToQueue: (a: unknown) => appendToQueueMock(a),
    getQueueState: () => getQueueStateMock(),
    ackEvents: (a: never) => ackEventsMock(a),
  },
}))

import { useCapacitorAudioPlayer } from "../useCapacitorAudioPlayer.js"

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function transition(over: Partial<QueueTransition> = {}): QueueTransition {
  return {
    finishedItemId: "a",
    fromPosition: 1.5,
    finishedAt: 10.25,
    duration: 100,
    startedItemId: "b",
    reason: "completed",
    at: 1_700_000_000_000,
    fromAt: 1_699_999_999_000,
    seq: 7,
    ...over,
  } as QueueTransition
}

beforeEach(() => {
  jumpCallbacks = []
  transitionCallbacks = []
  vi.clearAllMocks()
})

describe("useCapacitorAudioPlayer — seconds on the wire, milliseconds in the app", () => {
  it("seeks in seconds", async () => {
    await useCapacitorAudioPlayer().seek(90_500)
    expect(seekMock).toHaveBeenCalledWith({ position: 90.5 })
  })

  it("steps in seconds, forwards and back", async () => {
    const player = useCapacitorAudioPlayer()
    await player.seekBy(15_000)
    await player.seekBy(-30_000)
    expect(seekByMock.mock.calls.map((c) => c[0])).toEqual([{ delta: 15 }, { delta: -30 }])
  })

  it("treats a step of NaN as no movement rather than sending it to native", async () => {
    await useCapacitorAudioPlayer().seekBy(Number.NaN)
    expect(seekByMock).toHaveBeenCalledWith({ delta: 0 })
  })

  it("converts the queue's start position and item durations", async () => {
    await useCapacitorAudioPlayer().setQueue(
      [
        { itemId: "a", url: "a.mp3", title: "A", author: "X", cover: "c.jpg", durationMs: 60_000 },
        { itemId: "b", url: "b.mp3", title: "B", author: "X" },
      ],
      1,
      30_000
    )
    expect(setQueueMock).toHaveBeenCalledWith({
      items: [
        { itemId: "a", url: "a.mp3", title: "A", author: "X", cover: "c.jpg", duration: 60 },
        {
          itemId: "b",
          url: "b.mp3",
          title: "B",
          author: "X",
          cover: undefined,
          duration: undefined,
        },
      ],
      startIndex: 1,
      startPosition: 30,
    })
  })

  it("converts an appended item's duration too", async () => {
    await useCapacitorAudioPlayer().appendToQueue([
      { itemId: "c", url: "c.mp3", title: "C", author: "X", durationMs: 1_500 },
    ])
    expect(appendToQueueMock.mock.calls[0]![0]).toMatchObject({
      items: [expect.objectContaining({ duration: 1.5 })],
    })
  })

  it("reads the queue state back in milliseconds", async () => {
    getQueueStateMock.mockResolvedValue({
      currentItemId: "a",
      position: 12.3456,
      duration: 100.5,
      playing: true,
      queueCount: 3,
      events: [transition()],
    })

    expect(await useCapacitorAudioPlayer().getQueueState()).toEqual({
      currentItemId: "a",
      positionMs: 12_346,
      durationMs: 100_500,
      playing: true,
      queueCount: 3,
      events: [
        {
          finishedItemId: "a",
          fromPositionMs: 1500,
          finishedAtMs: 10_250,
          durationMs: 100_000,
          startedItemId: "b",
          reason: "completed",
          at: 1_700_000_000_000,
          fromAt: 1_699_999_999_000,
          seq: 7,
        },
      ],
    })
  })

  it("assumes a single-item queue when an older native build reports no count", async () => {
    getQueueStateMock.mockResolvedValue({
      currentItemId: "a",
      position: 0,
      duration: 0,
      playing: false,
      events: [],
    })
    expect((await useCapacitorAudioPlayer().getQueueState()).queueCount).toBe(1)
  })

  it("reports an empty queue when nothing is loaded and no count is reported", async () => {
    getQueueStateMock.mockResolvedValue({
      currentItemId: null,
      position: 0,
      duration: 0,
      playing: false,
      events: [],
    })
    expect((await useCapacitorAudioPlayer().getQueueState()).queueCount).toBe(0)
  })
})

describe("useCapacitorAudioPlayer — bounded settings", () => {
  it("passes a ratio inside the range through", async () => {
    await useCapacitorAudioPlayer().setMix({ enabled: true, ratio: 0.35 })
    expect(setMixMock).toHaveBeenCalledWith({ enabled: true, ratio: 0.35 })
  })

  it("clamps a ratio outside the range", async () => {
    const player = useCapacitorAudioPlayer()
    await player.setMix({ enabled: true, ratio: 2 })
    await player.setMix({ enabled: true, ratio: -1 })
    await player.setMix({ enabled: false, ratio: Number.NaN })
    expect(setMixMock.mock.calls.map((c) => c[0].ratio)).toEqual([1, 0, 0])
  })

  it("clamps the playback rate to what the engine supports", async () => {
    const player = useCapacitorAudioPlayer()
    await player.setPlaybackRate(0.25)
    await player.setPlaybackRate(3)
    await player.setPlaybackRate(Number.NaN)
    await player.setPlaybackRate(1.5)
    expect(setPlaybackRateMock.mock.calls.map((c) => c[0].rate)).toEqual([0.5, 2, 1, 1.5])
  })

  it("falls back to a one-second progress interval for an unusable value", async () => {
    const player = useCapacitorAudioPlayer()
    await player.setProgressInterval(0)
    await player.setProgressInterval(-5)
    await player.setProgressInterval(Number.POSITIVE_INFINITY)
    await player.setProgressInterval(250.4)
    expect(setProgressIntervalMock.mock.calls.map((c) => c[0].intervalMs)).toEqual([
      1000, 1000, 1000, 250,
    ])
  })
})

describe("useCapacitorAudioPlayer — a seek that was overtaken", () => {
  it("does not surface a superseded seek to the caller", async () => {
    seekMock.mockRejectedValueOnce(new Error("Seek operation failed"))
    await expect(useCapacitorAudioPlayer().seek(1000)).resolves.toBeUndefined()
  })

  it("does not surface a superseded step either", async () => {
    seekByMock.mockRejectedValueOnce(new Error("Seek operation failed"))
    await expect(useCapacitorAudioPlayer().seekBy(1000)).resolves.toBeUndefined()
  })

  it("still reports a genuine seek fault", async () => {
    seekMock.mockRejectedValueOnce(new Error("Plugin not implemented"))
    await expect(useCapacitorAudioPlayer().seek(1000)).rejects.toThrow("Plugin not implemented")
  })

  it("reports a rejection that is not an Error", async () => {
    seekMock.mockRejectedValueOnce({ message: "UNIMPLEMENTED" })
    await expect(useCapacitorAudioPlayer().seek(1000)).rejects.toMatchObject({
      message: "UNIMPLEMENTED",
    })
  })
})

describe("useCapacitorAudioPlayer — subscriptions", () => {
  it("delivers a position jump in milliseconds", async () => {
    const seen: unknown[] = []
    useCapacitorAudioPlayer().onPositionJump((j) => seen.push(j))
    await flush()

    for (const cb of jumpCallbacks) {
      cb({ itemId: "a", fromPosition: 1.25, toPosition: 90 } as PositionJump)
    }

    expect(seen).toEqual([{ itemId: "a", fromMs: 1250, toMs: 90_000 }])
  })

  it("stops delivering jumps after unsubscribe, keeping the registration", async () => {
    const seen: unknown[] = []
    const player = useCapacitorAudioPlayer()
    const off = player.onPositionJump((j) => seen.push(j))
    await flush()
    off()

    for (const cb of jumpCallbacks) {
      cb({ itemId: "a", fromPosition: 0, toPosition: 1 } as PositionJump)
    }

    expect(seen).toEqual([])
    expect(jumpCallbacks).toHaveLength(1)
  })

  it("delivers a queue transition in milliseconds", async () => {
    const seen: { durationMs?: number }[] = []
    useCapacitorAudioPlayer().onTransition((t) => seen.push(t))
    await flush()

    for (const cb of transitionCallbacks) cb(transition({ duration: 42.5 }))

    expect(seen[0]).toMatchObject({ durationMs: 42_500, fromPositionMs: 1500, seq: 7 })
  })

  it("registers the transition callback once for many subscribers", async () => {
    const player = useCapacitorAudioPlayer()
    player.onTransition(() => {})
    player.onTransition(() => {})
    await flush()

    expect(transitionCallbacks).toHaveLength(1)
  })

  it("acks the events it has consumed", async () => {
    await useCapacitorAudioPlayer().ackEvents(12)
    expect(ackEventsMock).toHaveBeenCalledWith({ upToSeq: 12 })
  })
})
