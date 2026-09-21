// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { MediaPayload } from "@lib/domain/chatMessage.js"

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    disconnect(): void {}
  }
)

const { default: MediaCardContainer } = await import("../MediaCardContainer.vue")

/* -- A playable media element ------------------------------------------- */

const pausedState = new WeakMap<HTMLMediaElement, boolean>()

beforeAll(() => {
  // jsdom ships no playback: `play()` throws and `paused` is a constant.
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return pausedState.get(this) ?? true
    },
  })
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    pausedState.set(this, false)
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  }
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    if (pausedState.get(this) === false) {
      pausedState.set(this, true)
      this.dispatchEvent(new Event("pause"))
    }
  }
})

interface FakeRange {
  readonly start: number
  readonly end: number
}

/** Give a mounted media element a duration, a playhead and buffered ranges. */
function describeMedia(
  el: HTMLMediaElement,
  opts: { duration: number; currentTime?: number; buffered?: readonly FakeRange[] }
): void {
  Object.defineProperty(el, "duration", { configurable: true, value: opts.duration })
  Object.defineProperty(el, "currentTime", {
    configurable: true,
    writable: true,
    value: opts.currentTime ?? 0,
  })
  const ranges = opts.buffered ?? []
  Object.defineProperty(el, "buffered", {
    configurable: true,
    value: {
      length: ranges.length,
      start: (i: number) => ranges[i].start,
      end: (i: number) => ranges[i].end,
    },
  })
}

/* -- Harness ------------------------------------------------------------ */

const videoPayload: MediaPayload = {
  id: "m1",
  url: "media/kirtan.mp4",
  type: "video",
  title: "Evening kirtan",
  speaker: "Gour Govinda Swami",
  date: "1991-02-03",
  text: "translated words",
}

let apps: App[] = []

afterEach(() => {
  for (const app of apps) app.unmount()
  apps = []
  document.body.innerHTML = ""
})

function render(
  payload: MediaPayload | undefined,
  resolveUrl?: (path: string) => string
): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      setup: () => () => h(MediaCardContainer, { payload, resolveUrl }),
    })
  )
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  apps.push(app)
  return host
}

const mediaEl = (host: HTMLElement): HTMLMediaElement =>
  host.querySelector("video, audio") as HTMLMediaElement

const widthOf = (host: HTMLElement, cls: string): string =>
  (host.querySelector(cls) as HTMLElement).style.width

describe("the media element the payload asks for", () => {
  it("renders a video stage with the resolved file and a derived poster", () => {
    const host = render(videoPayload, (p) => `https://cdn.example/${p}`)
    const video = host.querySelector("video") as HTMLVideoElement
    expect(video).not.toBeNull()
    expect(host.querySelector("audio")).toBeNull()
    expect(video.getAttribute("src")).toBe("https://cdn.example/media/kirtan.mp4")
    expect(video.getAttribute("poster")).toBe("https://cdn.example/media/kirtan.jpg")
  })

  it("falls back to an audio row for an audio payload", () => {
    const host = render({ ...videoPayload, type: "audio", url: "media/talk.mp3" })
    expect(host.querySelector("video")).toBeNull()
    expect(host.querySelector("audio")?.getAttribute("src")).toBe("media/talk.mp3")
  })

  it("treats an unknown media type as audio rather than dropping it", () => {
    const host = render({ ...videoPayload, type: "livestream" as MediaPayload["type"] })
    expect(host.querySelector("video")).toBeNull()
    expect(host.querySelector("audio")).not.toBeNull()
  })

  it("passes the raw path through when no resolver is supplied", () => {
    const host = render(videoPayload)
    expect(host.querySelector("video")?.getAttribute("src")).toBe("media/kirtan.mp4")
    expect(host.querySelector("video")?.getAttribute("poster")).toBe("media/kirtan.jpg")
  })

  // A poster pointing at the video itself decodes as nothing, so the stage
  // went blank instead of showing the first frame.
  it.each([
    ["an extensionless url", "media/kirtan"],
    ["a dot that belongs to a directory", "media.v2/kirtan"],
  ])("draws no poster for %s", (_label, url) => {
    const host = render({ ...videoPayload, url })
    const video = host.querySelector("video")
    expect(video?.hasAttribute("poster")).toBe(false)
    expect(video?.getAttribute("src")).toBe(url)
  })

  it("renders nothing at all without a payload", () => {
    const host = render(undefined)
    expect(host.querySelector("article")).toBeNull()
    expect(host.querySelector("video, audio")).toBeNull()
  })
})

describe("the card body", () => {
  it("shows the title and joins speaker and date into one attribution", () => {
    const host = render(videoPayload)
    expect(host.querySelector(".media-card-title")?.textContent).toBe("Evening kirtan")
    expect(host.querySelector(".media-card-attribution")?.textContent).toBe(
      "Gour Govinda Swami · 1991-02-03"
    )
  })

  it("drops the separator when only the speaker is known", () => {
    const host = render({ ...videoPayload, date: undefined })
    expect(host.querySelector(".media-card-attribution")?.textContent).toBe("Gour Govinda Swami")
  })

  it("hides the attribution line when neither speaker nor date is given", () => {
    const host = render({ ...videoPayload, speaker: undefined, date: undefined })
    expect(host.querySelector(".media-card-attribution")).toBeNull()
  })

  it("offers no transcript toggle for an empty transcript", () => {
    const host = render({ ...videoPayload, text: "" })
    expect(host.querySelector(".expand-btn")).toBeNull()
  })

  it("reveals the transcript when expanded", async () => {
    const host = render(videoPayload)
    expect(host.querySelector(".media-card-transcript")).toBeNull()
    ;(host.querySelector(".expand-btn") as HTMLButtonElement).click()
    await nextTick()
    expect(host.querySelector(".media-card-transcript-text")?.textContent).toBe("translated words")
  })
})

describe("the machine-translation toggle", () => {
  const mtPayload: MediaPayload = {
    ...videoPayload,
    mt: true,
    text: "translated words",
    textOriginal: "original words",
  }

  it("offers the original once the transcript is open", async () => {
    const host = render(mtPayload)
    expect(host.querySelector(".translation-notice")).toBeNull()
    ;(host.querySelector(".expand-btn") as HTMLButtonElement).click()
    await nextTick()

    expect(host.querySelector(".media-card-transcript-text")?.textContent).toBe("translated words")
    ;(host.querySelector(".translation-notice__toggle") as HTMLButtonElement).click()
    await nextTick()
    expect(host.querySelector(".media-card-transcript-text")?.textContent).toBe("original words")
  })

  it("stays silent when the translation flag has no original behind it", async () => {
    const host = render({ ...videoPayload, mt: true })
    ;(host.querySelector(".expand-btn") as HTMLButtonElement).click()
    await nextTick()
    expect(host.querySelector(".translation-notice")).toBeNull()
  })

  it("stays silent for an original with no translation flag", async () => {
    const host = render({ ...videoPayload, textOriginal: "original words" })
    ;(host.querySelector(".expand-btn") as HTMLButtonElement).click()
    await nextTick()
    expect(host.querySelector(".translation-notice")).toBeNull()
  })
})

describe("progress and buffering", () => {
  it("reports the playhead as a fraction of duration", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: 200, currentTime: 50, buffered: [{ start: 0, end: 100 }] })

    el.dispatchEvent(new Event("timeupdate"))
    await nextTick()

    expect(widthOf(host, ".progress-fill")).toBe("25%")
    expect(widthOf(host, ".progress-buffered")).toBe("50%")
  })

  it("stays at zero while the duration is still unknown", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: NaN, currentTime: 10 })

    el.dispatchEvent(new Event("timeupdate"))
    await nextTick()

    expect(widthOf(host, ".progress-fill")).toBe("0%")
    expect(widthOf(host, ".progress-buffered")).toBe("0%")
  })

  it("prefers the buffered range the playhead sits inside", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, {
      duration: 100,
      currentTime: 60,
      buffered: [
        { start: 0, end: 20 },
        { start: 50, end: 70 },
        { start: 90, end: 100 },
      ],
    })

    el.dispatchEvent(new Event("progress"))
    await nextTick()

    expect(widthOf(host, ".progress-buffered")).toBe("70%")
  })

  it("falls back to the furthest range when the playhead sits in a gap", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, {
      duration: 100,
      currentTime: 35,
      buffered: [
        { start: 0, end: 20 },
        { start: 50, end: 80 },
      ],
    })

    el.dispatchEvent(new Event("progress"))
    await nextTick()

    expect(widthOf(host, ".progress-buffered")).toBe("80%")
  })

  it("reports nothing buffered before the first range arrives", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: 100, currentTime: 10, buffered: [] })

    el.dispatchEvent(new Event("loadedmetadata"))
    await nextTick()

    expect(widthOf(host, ".progress-buffered")).toBe("0%")
  })
})

describe("seeking", () => {
  it("moves the playhead to the tapped fraction of the bar", () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: 200 })

    const bar = host.querySelector(".progress") as HTMLElement
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
    bar.dispatchEvent(new MouseEvent("click", { clientX: 30, bubbles: true }))

    expect(el.currentTime).toBe(60)
  })

  it("clamps a tap past the right edge to the end", () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: 200 })

    const bar = host.querySelector(".progress") as HTMLElement
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
    bar.dispatchEvent(new MouseEvent("click", { clientX: 400, bubbles: true }))

    expect(el.currentTime).toBe(200)
  })

  it("ignores a seek while the duration is unknown", () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    describeMedia(el, { duration: 0, currentTime: 7 })

    const bar = host.querySelector(".progress") as HTMLElement
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect
    bar.dispatchEvent(new MouseEvent("click", { clientX: 50, bubbles: true }))

    expect(el.currentTime).toBe(7)
  })
})

describe("playback and the one-sound-at-a-time rule", () => {
  it("starts on the overlay tap and swaps it for the stage", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    expect(host.querySelector(".play-overlay")).not.toBeNull()
    ;(host.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()

    expect(el.paused).toBe(false)
    expect(host.querySelector(".play-overlay")).toBeNull()
  })

  it("pauses again on a second tap on the video itself", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    ;(host.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()

    el.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await nextTick()

    expect(el.paused).toBe(true)
    expect(host.querySelector(".play-overlay")).not.toBeNull()
  })

  it("pauses the card that was already playing", async () => {
    const first = render(videoPayload)
    const second = render({ ...videoPayload, id: "m2", url: "media/other.mp4" })
    ;(first.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()
    expect(mediaEl(first).paused).toBe(false)
    ;(second.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()

    expect(mediaEl(first).paused).toBe(true)
    expect(mediaEl(second).paused).toBe(false)
  })

  it("survives a rejected play() and stays paused", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    el.play = () => Promise.reject(new Error("autoplay blocked"))
    ;(host.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()

    expect(el.paused).toBe(true)
    expect(host.querySelector(".play-overlay")).not.toBeNull()
  })

  it("clears the playing state when the media ends", async () => {
    const host = render(videoPayload)
    const el = mediaEl(host)
    ;(host.querySelector(".play-overlay") as HTMLButtonElement).click()
    await nextTick()

    el.dispatchEvent(new Event("ended"))
    await nextTick()

    expect(host.querySelector(".play-overlay")).not.toBeNull()
  })
})
