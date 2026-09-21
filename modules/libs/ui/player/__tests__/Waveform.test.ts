// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import Waveform from "../Waveform.vue"

interface Props {
  peaks: number[]
  progressFraction: number
  chapters?: { title: string; startMs: number; endMs: number }[]
  durationMs?: number
  positionMs?: number
}

interface Mounted {
  host: HTMLElement
  props: Props
  seeks: number
  chapterSeeks: number[]
  hovers: (string | null)[]
}

function mount(props: Props): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = { host, props: state, seeks: 0, chapterSeeks: [], hovers: [] }
  createApp({
    render: () =>
      h(Waveform, {
        ...state,
        onSeek: () => (m.seeks += 1),
        "onChapter-seek": (ms: number) => m.chapterSeeks.push(ms),
        "onChapter-hover": (title: string | null) => m.hovers.push(title),
      }),
  }).mount(host)
  return m
}

function bars(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".bar")]
}

describe("Waveform", () => {
  it("draws one bar per peak at its own height", () => {
    const { host } = mount({ peaks: [10, 50, 100], progressFraction: 0 })

    const drawn = bars(host)
    expect(drawn).toHaveLength(3)
    expect(drawn.map((b) => b.style.height)).toEqual(["10%", "50%", "100%"])
  })

  it("colours only the bars behind the playhead as played", () => {
    const { host } = mount({ peaks: [1, 2, 3, 4], progressFraction: 0.5 })

    expect(bars(host).map((b) => b.classList.contains("is-played"))).toEqual([
      true,
      true,
      false,
      false,
    ])
  })

  it("has nothing played at the very start", () => {
    const { host } = mount({ peaks: [1, 2, 3, 4], progressFraction: 0 })

    expect(bars(host).some((b) => b.classList.contains("is-played"))).toBe(false)
  })

  it("seeks when the strip is clicked", () => {
    const m = mount({ peaks: [1, 2, 3], progressFraction: 0 })

    m.host.querySelector<HTMLElement>(".waveform")!.click()

    expect(m.seeks).toBe(1)
  })
})

describe("Waveform — chapter separators", () => {
  const chapters = [
    { title: "Opening", startMs: 0, endMs: 1000 },
    { title: "Verse 13", startMs: 2500, endMs: 5000 },
    { title: "Questions", startMs: 7500, endMs: 10000 },
  ]
  const peaks = [10, 20, 30, 40, 50]

  it("puts a separator at the bar the chapter starts on", () => {
    const { host } = mount({ peaks, progressFraction: 0, chapters, durationMs: 10000 })

    const seps = [...host.querySelectorAll<HTMLElement>(".bar.sep")]
    expect(seps.map((s) => s.getAttribute("title"))).toEqual(["Verse 13", "Questions"])
    expect(bars(host).indexOf(seps[0])).toBe(1)
    expect(bars(host).indexOf(seps[1])).toBe(3)
  })

  it("does not put a separator over the first bar", () => {
    const { host } = mount({ peaks, progressFraction: 0, chapters, durationMs: 10000 })

    // "Opening" starts at 0, which would land on bar 0 and hide a real peak.
    expect(host.querySelector('[title="Opening"]')).toBeNull()
  })

  it("marks the chapter the playhead is inside as active", () => {
    const { host } = mount({
      peaks,
      progressFraction: 0.3,
      chapters,
      durationMs: 10000,
      positionMs: 3000,
    })

    const active = [...host.querySelectorAll<HTMLElement>(".bar.sep.is-active")]
    expect(active.map((s) => s.getAttribute("title"))).toEqual(["Verse 13"])
  })

  it("moves the active marker as playback advances", async () => {
    const m = mount({
      peaks,
      progressFraction: 0.3,
      chapters,
      durationMs: 10000,
      positionMs: 3000,
    })

    m.props.positionMs = 8000
    await nextTick()

    expect(m.host.querySelector(".bar.sep.is-active")!.getAttribute("title")).toBe("Questions")
  })

  it("jumps to a chapter without also seeking to the click position", () => {
    const m = mount({ peaks, progressFraction: 0, chapters, durationMs: 10000 })

    m.host.querySelector<HTMLElement>('[title="Verse 13"]')!.click()

    expect(m.chapterSeeks).toEqual([2500])
    expect(m.seeks).toBe(0)
  })

  it("announces the chapter under the pointer and clears it on leave", () => {
    const m = mount({ peaks, progressFraction: 0, chapters, durationMs: 10000 })
    const sep = m.host.querySelector<HTMLElement>('[title="Questions"]')!

    sep.dispatchEvent(new MouseEvent("mouseenter"))
    sep.dispatchEvent(new MouseEvent("mouseleave"))

    expect(m.hovers).toEqual(["Questions", null])
  })

  it("draws no separators without a known duration", () => {
    const { host } = mount({ peaks, progressFraction: 0, chapters })

    expect(host.querySelectorAll(".bar.sep")).toHaveLength(0)
    expect(bars(host)).toHaveLength(peaks.length)
  })

  it("clamps a chapter that starts past the end of the recording", () => {
    const { host } = mount({
      peaks,
      progressFraction: 0,
      chapters: [{ title: "Late", startMs: 99_000, endMs: 100_000 }],
      durationMs: 10000,
    })

    const seps = [...host.querySelectorAll<HTMLElement>(".bar.sep")]
    expect(bars(host).indexOf(seps[0])).toBe(peaks.length - 1)
  })
})
