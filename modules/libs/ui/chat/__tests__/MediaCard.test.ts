// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive, type Slots } from "vue"
import MediaCard from "../MediaCard.vue"
import type { UiMediaPayload } from "../types.js"

interface Props {
  payload?: UiMediaPayload
  isPlaying?: boolean
  progressFraction?: number
  bufferedFraction?: number
  transcriptText?: string
  isMt?: boolean
  showOriginal?: boolean
}

interface Mounted {
  host: HTMLElement
  props: Props
  toggles: number
  seeks: number[]
  originals: boolean[]
}

function mount(props: Props, slots: Slots = {}): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = { host, props: state, toggles: 0, seeks: [], originals: [] }
  const app = createApp({
    render: () =>
      h(
        MediaCard,
        {
          ...state,
          onToggle: () => (m.toggles += 1),
          onSeek: (f: number) => m.seeks.push(f),
          "onUpdate:show-original": (v: boolean) => m.originals.push(v),
        },
        slots
      ),
  })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return m
}

const video: UiMediaPayload = {
  type: "video",
  title: "Morning Walk",
  text: "The soul is eternal.",
  speaker: "Prabhupada",
  date: "1974-05-27",
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10 } as DOMRect
  }
})

describe("MediaCard", () => {
  it("renders nothing until the media payload resolves", () => {
    const m = mount({})

    expect(m.host.querySelector(".media-card")).toBeNull()
  })

  it("shows the title and the speaker-and-date line", () => {
    const m = mount({ payload: video })

    expect(m.host.querySelector(".media-card-title")!.textContent).toBe("Morning Walk")
    expect(m.host.querySelector(".media-card-attribution")!.textContent).toBe(
      "Prabhupada · 1974-05-27"
    )
  })

  it("leaves out the attribution line when neither part is known", () => {
    const m = mount({ payload: { type: "video", title: "Untitled", text: "" } })

    expect(m.host.querySelector(".media-card-attribution")).toBeNull()
  })

  it("joins only the part it has", () => {
    const m = mount({ payload: { ...video, date: undefined } })

    expect(m.host.querySelector(".media-card-attribution")!.textContent).toBe("Prabhupada")
  })

  it("puts the play overlay over a stopped video and takes it away once it runs", async () => {
    const m = mount({ payload: video })

    expect(m.host.querySelector(".play-overlay")).not.toBeNull()

    m.props.isPlaying = true
    await nextTick()

    expect(m.host.querySelector(".play-overlay")).toBeNull()
  })

  it("keeps a play/pause button for audio and labels it either way", async () => {
    const m = mount({ payload: { ...video, type: "audio" } })
    const btn = m.host.querySelector<HTMLButtonElement>(".play-overlay")!

    expect(btn.getAttribute("aria-label")).toBe("Play")

    m.props.isPlaying = true
    await nextTick()

    expect(btn.getAttribute("aria-label")).toBe("Pause")
  })

  it("asks the host to toggle playback", () => {
    const m = mount({ payload: video })

    m.host.querySelector<HTMLButtonElement>(".play-overlay")!.click()

    expect(m.toggles).toBe(1)
  })

  it("shows the playhead and the buffered span as widths", () => {
    const m = mount({ payload: video, progressFraction: 0.4, bufferedFraction: 0.75 })

    expect(m.host.querySelector<HTMLElement>(".progress-fill")!.style.width).toBe("40%")
    expect(m.host.querySelector<HTMLElement>(".progress-buffered")!.style.width).toBe("75%")
    expect(m.host.querySelector<HTMLElement>(".progress-dot")!.style.left).toBe("40%")
  })

  it("never draws past either end of the bar", () => {
    const m = mount({ payload: video, progressFraction: 2, bufferedFraction: -1 })

    expect(m.host.querySelector<HTMLElement>(".progress-fill")!.style.width).toBe("100%")
    expect(m.host.querySelector<HTMLElement>(".progress-buffered")!.style.width).toBe("0%")
  })

  it("reports a scrub as a fraction of the duration", () => {
    const m = mount({ payload: video })

    m.host
      .querySelector<HTMLElement>(".progress")!
      .dispatchEvent(new MouseEvent("click", { clientX: 25 }))

    expect(m.seeks).toEqual([0.25])
  })

  it("clamps a scrub past the end of the bar", () => {
    const m = mount({ payload: video })

    m.host
      .querySelector<HTMLElement>(".progress")!
      .dispatchEvent(new MouseEvent("click", { clientX: 500 }))

    expect(m.seeks).toEqual([1])
  })
})

describe("MediaCard — transcript", () => {
  it("keeps the transcript folded away until it is asked for", async () => {
    const m = mount({ payload: video, transcriptText: "The soul is eternal." })

    expect(m.host.querySelector(".media-card-transcript")).toBeNull()

    m.host.querySelector<HTMLButtonElement>(".expand-btn")!.click()
    await nextTick()

    expect(m.host.querySelector(".media-card-transcript-text")!.textContent).toBe(
      "The soul is eternal."
    )
  })

  it("relabels the expander once the transcript is open", async () => {
    const m = mount({ payload: video, transcriptText: "The soul is eternal." })
    const btn = m.host.querySelector<HTMLButtonElement>(".expand-btn")!

    expect(btn.getAttribute("aria-label")).toBe("Show transcript")

    btn.click()
    await nextTick()

    expect(btn.getAttribute("aria-label")).toBe("Hide transcript")
  })

  it("offers no expander for a clip with no transcript", () => {
    const m = mount({ payload: { ...video, text: "" } })

    expect(m.host.querySelector(".expand-btn")).toBeNull()
  })

  it("discloses a machine translation only while the transcript is open", async () => {
    const m = mount({ payload: video, transcriptText: "Душа вечна.", isMt: true })

    expect(m.host.querySelector(".translation-notice")).toBeNull()

    m.host.querySelector<HTMLButtonElement>(".expand-btn")!.click()
    await nextTick()

    expect(m.host.querySelector(".translation-notice")).not.toBeNull()
  })

  it("hands the translation toggle back to the host", async () => {
    const m = mount({ payload: video, transcriptText: "Душа вечна.", isMt: true })

    m.host.querySelector<HTMLButtonElement>(".expand-btn")!.click()
    await nextTick()
    m.host.querySelector<HTMLButtonElement>(".translation-notice__toggle")!.click()

    expect(m.originals).toEqual([true])
  })
})
