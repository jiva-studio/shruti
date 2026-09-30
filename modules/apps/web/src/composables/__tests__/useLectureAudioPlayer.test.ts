import { afterEach, describe, expect, it, vi } from "vitest"
import { useLectureAudioPlayer } from "../useLectureAudioPlayer"

function refusingAudio(error: Error): HTMLAudioElement {
  return {
    paused: true,
    currentTime: 0,
    duration: 60,
    play: vi.fn(() => Promise.reject(error)),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe("useLectureAudioPlayer refused play()", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("resets busy and playing and logs when toggle's play() is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const refusal = new DOMException("autoplay blocked", "NotAllowedError")
    const player = useLectureAudioPlayer()
    player.audioEl.value = refusingAudio(refusal)
    player.onWaiting()
    player.onPlay()

    player.toggle()
    await flush()

    expect(player.busy.value).toBe(false)
    expect(player.playing.value).toBe(false)
    expect(warn.mock.calls.some((args) => args.includes(refusal))).toBe(true)
  })

  it("resets busy and playing and logs when seek's play() is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const refusal = new DOMException("autoplay blocked", "NotAllowedError")
    const player = useLectureAudioPlayer()
    player.audioEl.value = refusingAudio(refusal)
    player.onWaiting()
    player.onPlay()

    player.seek(5000)
    await flush()

    expect(player.busy.value).toBe(false)
    expect(player.playing.value).toBe(false)
    expect(warn.mock.calls.some((args) => args.includes(refusal))).toBe(true)
  })
})
