import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Status } from "@shruti/plugin-audio-player"
import type { AudioStatus } from "@ports/app/audioPlayer.js"

/**
 * The Capacitor audio adapter, driven against a fake plugin.
 *
 * Everything here turns on one fact about the native side: it emits nothing
 * until JS has saved a callback with it (`onProgressChanged` on both
 * platforms). The adapter multiplexes app listeners locally, so a missing
 * registration is invisible from JS — the local fan-out looks healthy while no
 * event ever arrives. That is the shape of #1776: when the JS context restarts
 * over live playback (iOS jetsams the webview content process while the engine
 * keeps playing in the background), the store re-subscribes but never calls
 * `open` / `setQueue`, so progress stayed dead until a DIFFERENT lecture was
 * opened — and a partial listen ending in a pause was never journaled.
 */

type StatusCallback = (status: Status) => void

let progressCallbacks: StatusCallback[] = []

const onProgressChangedMock = vi.fn(async (cb: StatusCallback) => {
  progressCallbacks.push(cb)
  return { callbackId: "progress" }
})
const onPositionJumpMock = vi.fn(async () => ({ callbackId: "jump" }))
const onItemTransitionMock = vi.fn(async () => ({ callbackId: "transition" }))
const openMock = vi.fn(async () => {})
const setQueueMock = vi.fn(async () => {})

vi.mock("@shruti/plugin-audio-player", () => ({
  AudioPlayer: {
    onProgressChanged: (cb: never) => onProgressChangedMock(cb),
    onPositionJump: () => onPositionJumpMock(),
    onItemTransition: () => onItemTransitionMock(),
    open: () => openMock(),
    setQueue: () => setQueueMock(),
  },
}))

import { useCapacitorAudioPlayer } from "../useCapacitorAudioPlayer.js"

/** Let the fire-and-forget `void ensureRegistered()` settle. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function emit(status: Status): void {
  for (const cb of progressCallbacks) cb(status)
}

beforeEach(() => {
  progressCallbacks = []
  vi.clearAllMocks()
})

describe("useCapacitorAudioPlayer progress registration", () => {
  it("registers with the plugin on subscribe, with no open/setQueue", async () => {
    const player = useCapacitorAudioPlayer()

    player.onProgress(() => {})
    await flush()

    expect(onProgressChangedMock).toHaveBeenCalledTimes(1)
    expect(openMock).not.toHaveBeenCalled()
    expect(setQueueMock).not.toHaveBeenCalled()
  })

  it("delivers native progress to a listener that only ever subscribed", async () => {
    const player = useCapacitorAudioPlayer()
    const seen: AudioStatus[] = []

    player.onProgress((s) => {
      seen.push(s)
    })
    await flush()
    emit({ itemId: "item-1", playing: true, position: 12.5, duration: 100 })

    // Plugin speaks seconds, the port speaks milliseconds.
    expect(seen).toEqual([{ itemId: "item-1", playing: true, position: 12500, duration: 100000 }])
  })

  it("registers once across repeated subscriptions", async () => {
    const player = useCapacitorAudioPlayer()

    player.onProgress(() => {})
    player.onProgress(() => {})
    await flush()
    player.onProgress(() => {})
    await flush()

    expect(onProgressChangedMock).toHaveBeenCalledTimes(1)
    expect(progressCallbacks).toHaveLength(1)
  })

  it("does not re-register when open runs after a subscription", async () => {
    const player = useCapacitorAudioPlayer()

    player.onProgress(() => {})
    await flush()
    await player.open({ itemId: "item-1", url: "https://x.test/a.mp3", title: "t", author: "a" })

    expect(onProgressChangedMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the registration when a listener unsubscribes", async () => {
    const player = useCapacitorAudioPlayer()
    const seen: AudioStatus[] = []

    const off = player.onProgress((s) => {
      seen.push(s)
    })
    await flush()
    off()
    emit({ itemId: "item-1", playing: true, position: 1, duration: 100 })

    expect(seen).toEqual([])
    expect(onProgressChangedMock).toHaveBeenCalledTimes(1)
  })
})
