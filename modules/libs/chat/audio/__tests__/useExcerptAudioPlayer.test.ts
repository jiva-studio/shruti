// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, h, nextTick, ref, type Ref } from "vue"
import { useExcerptAudioPlayer } from "../useExcerptAudioPlayer.js"

type Player = ReturnType<typeof useExcerptAudioPlayer>
type Options = Parameters<typeof useExcerptAudioPlayer>[0]

interface FakeAudio {
  src: string
  currentTime: number
  duration: number
  pauses: number
  plays: number
  play: () => Promise<void>
  pause: () => void
}

function makeAudio(play: () => Promise<void> = () => Promise.resolve()): FakeAudio {
  const el: FakeAudio = {
    src: "",
    currentTime: 0,
    duration: 0,
    pauses: 0,
    plays: 0,
    play: () => {
      el.plays += 1
      return play()
    },
    pause: () => {
      el.pauses += 1
    },
  }
  return el
}

function mountPlayer(
  overrides: Partial<Options> = {},
  play?: () => Promise<void>
): { player: Player; el: FakeAudio; unmount: () => void } {
  const el = makeAudio(play)
  let player!: Player
  const app = createApp({
    setup() {
      player = useExcerptAudioPlayer({
        hasSource: () => true,
        cachedUrl: () => null,
        resolveUrl: () => Promise.resolve("https://cdn/excerpt.mp3"),
        logLabel: "test-player",
        ...overrides,
      })
      return () => h("div")
    },
  })
  app.mount(document.createElement("div"))
  player.audioEl.value = el as unknown as HTMLAudioElement
  return { player, el, unmount: () => app.unmount() }
}

/** A waveform click at `clientX` over a 200px-wide bar strip starting at x=100. */
function clickAt(clientX: number): MouseEvent {
  const target = document.createElement("div")
  target.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect
  return { currentTarget: target, clientX } as unknown as MouseEvent
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  vi.useRealTimers()
})

describe("useExcerptAudioPlayer — starting playback", () => {
  it("resolves the cut, points the element at it and asks it to play", async () => {
    const { player, el } = mountPlayer({ resolveUrl: () => Promise.resolve("https://cdn/cut.mp3") })

    await player.onToggle()

    expect(el.src).toBe("https://cdn/cut.mp3")
    expect(el.plays).toBe(1)
    expect(player.isPreparing.value).toBe(true)
    expect(player.isPlaying.value).toBe(false)
  })

  it("reuses an already-cut url instead of cutting again", async () => {
    let cuts = 0
    const { player, el } = mountPlayer({
      cachedUrl: () => "https://cdn/known.mp3",
      resolveUrl: () => {
        cuts += 1
        return Promise.resolve("https://cdn/fresh.mp3")
      },
    })

    await player.onToggle()

    expect(cuts).toBe(0)
    expect(el.src).toBe("https://cdn/known.mp3")
  })

  it("keeps the element's own src when one is already loaded", async () => {
    const { player, el } = mountPlayer({ cachedUrl: () => "https://cdn/known.mp3" })
    el.src = "https://cdn/already-loaded.mp3"

    await player.onToggle()

    expect(el.src).toBe("https://cdn/already-loaded.mp3")
  })

  it("does nothing at all without a source key", async () => {
    const { player, el } = mountPlayer({ hasSource: () => false })

    await player.onToggle()

    expect(el.plays).toBe(0)
    expect(el.src).toBe("")
    expect(player.isPreparing.value).toBe(false)
  })

  it("drops the spinner when the cut fails", async () => {
    const { player, el } = mountPlayer({ resolveUrl: () => Promise.reject(new Error("502")) })

    await player.onToggle()

    expect(player.isPreparing.value).toBe(false)
    expect(el.plays).toBe(0)
  })

  it("drops the spinner when play() is rejected", async () => {
    const { player } = mountPlayer({}, () => Promise.reject(new Error("NotAllowedError")))

    await player.onToggle()

    expect(player.isPreparing.value).toBe(false)
    expect(player.isPlaying.value).toBe(false)
  })

  it("shows the pause icon only once sound actually starts", async () => {
    const { player } = mountPlayer()

    await player.onToggle()
    expect(player.isPlaying.value).toBe(false)
    expect(player.isPreparing.value).toBe(true)

    player.onPlaying()

    expect(player.isPlaying.value).toBe(true)
    expect(player.isPreparing.value).toBe(false)
  })

  it("gives up and pauses when playback never starts", async () => {
    vi.useFakeTimers()
    const { player, el } = mountPlayer()

    await player.onToggle()
    await vi.advanceTimersByTimeAsync(15000)

    expect(player.isPreparing.value).toBe(false)
    expect(player.isPlaying.value).toBe(false)
    expect(el.pauses).toBe(1)
  })

  it("does not pause a clip that started before the watchdog fires", async () => {
    vi.useFakeTimers()
    const { player, el } = mountPlayer()

    await player.onToggle()
    player.onPlay()
    await vi.advanceTimersByTimeAsync(20000)

    expect(player.isPlaying.value).toBe(true)
    expect(el.pauses).toBe(0)
  })
})

describe("useExcerptAudioPlayer — element events", () => {
  it("pauses a playing clip on the next toggle without re-cutting", async () => {
    let cuts = 0
    const { player, el } = mountPlayer({
      resolveUrl: () => {
        cuts += 1
        return Promise.resolve("https://cdn/cut.mp3")
      },
    })

    await player.onToggle()
    player.onPlay()
    await player.onToggle()

    expect(el.pauses).toBe(1)
    expect(cuts).toBe(1)
    player.onPause()
    expect(player.isPlaying.value).toBe(false)
  })

  it("re-shows the spinner on a buffer underrun and hides it when the buffer catches up", () => {
    const { player } = mountPlayer()

    player.onPlay()
    player.onWaiting()
    expect(player.isPreparing.value).toBe(true)

    player.onCanPlay()
    expect(player.isPreparing.value).toBe(false)
  })

  it("leaves the spinner alone when the buffer catches up on a paused clip", () => {
    const { player } = mountPlayer()

    player.onWaiting()
    player.onCanPlay()

    expect(player.isPreparing.value).toBe(true)
  })

  it("clears both flags on an element error", async () => {
    const { player } = mountPlayer()

    await player.onToggle()
    player.onPlay()
    player.onError()

    expect(player.isPlaying.value).toBe(false)
    expect(player.isPreparing.value).toBe(false)
  })

  it("rewinds to the start when the clip ends", () => {
    const { player, el } = mountPlayer()

    el.duration = 100
    player.onMetadata()
    el.currentTime = 100
    player.onTimeUpdate()
    expect(player.progressFraction.value).toBe(1)

    player.onEnded()

    expect(el.currentTime).toBe(0)
    expect(player.progressFraction.value).toBe(0)
    expect(player.isPlaying.value).toBe(false)
  })
})

describe("useExcerptAudioPlayer — progress and seeking", () => {
  it("reports progress as a fraction of the clip", () => {
    const { player, el } = mountPlayer()

    el.duration = 40
    player.onMetadata()
    el.currentTime = 10
    player.onTimeUpdate()

    expect(player.progressFraction.value).toBe(0.25)
  })

  it("is at zero while the duration is unknown", () => {
    const { player, el } = mountPlayer()

    el.currentTime = 10
    player.onTimeUpdate()

    expect(player.progressFraction.value).toBe(0)
  })

  it("never reports progress outside 0..1", () => {
    const { player, el } = mountPlayer()

    el.duration = 10
    player.onMetadata()
    el.currentTime = 99
    player.onTimeUpdate()
    expect(player.progressFraction.value).toBe(1)

    el.currentTime = -5
    player.onTimeUpdate()
    expect(player.progressFraction.value).toBe(0)
  })

  it("seeks to the tapped point of the waveform", () => {
    const { player, el } = mountPlayer()

    el.duration = 80
    player.onMetadata()
    player.onWaveformClick(clickAt(150))

    expect(el.currentTime).toBe(20)
  })

  it("clamps a tap past either end of the waveform", () => {
    const { player, el } = mountPlayer()

    el.duration = 80
    player.onMetadata()

    player.onWaveformClick(clickAt(1000))
    expect(el.currentTime).toBe(80)

    player.onWaveformClick(clickAt(0))
    expect(el.currentTime).toBe(0)
  })

  it("ignores a waveform tap before the duration is known", () => {
    const { player, el } = mountPlayer()

    player.onWaveformClick(clickAt(150))

    expect(el.currentTime).toBe(0)
  })
})

describe("useExcerptAudioPlayer — mutual exclusion", () => {
  it("rewinds and pauses when another inline player starts", async () => {
    const first = mountPlayer()
    const second = mountPlayer()

    first.el.duration = 60
    first.player.onMetadata()
    first.el.currentTime = 30
    first.player.onTimeUpdate()
    first.player.onPlay()

    await second.player.onToggle()

    expect(first.el.pauses).toBe(1)
    expect(first.el.currentTime).toBe(0)
    expect(first.player.progressFraction.value).toBe(0)

    first.unmount()
    second.unmount()
  })

  it("stops claiming the floor once unmounted", async () => {
    const first = mountPlayer()
    const second = mountPlayer()

    first.unmount()
    first.el.pauses = 0
    await second.player.onToggle()

    expect(first.el.pauses).toBe(0)
    second.unmount()
  })

  it("pauses the element when the host unmounts", async () => {
    const { player, el, unmount } = mountPlayer()

    await player.onToggle()
    player.onPlay()
    unmount()

    expect(el.pauses).toBe(1)
  })
})

describe("useExcerptAudioPlayer — deactivation", () => {
  it("rewinds and pauses when the host marks it inactive", async () => {
    const active: Ref<boolean> = ref(true)
    const { player, el } = mountPlayer({ active: () => active.value })

    el.duration = 60
    player.onMetadata()
    el.currentTime = 30
    player.onTimeUpdate()
    player.onPlay()

    active.value = false
    await nextTick()

    expect(el.pauses).toBe(1)
    expect(el.currentTime).toBe(0)
    expect(player.progressFraction.value).toBe(0)
  })

  it("leaves a player alone while it stays active", async () => {
    const active = ref(true)
    const { player, el } = mountPlayer({ active: () => active.value })

    await player.onToggle()
    player.onPlay()
    active.value = true
    await nextTick()

    expect(el.pauses).toBe(0)
    expect(player.isPlaying.value).toBe(true)
  })
})
