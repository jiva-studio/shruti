// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import TranscriptView from "../TranscriptView.vue"

interface Block {
  type: string
  start: number
  end: number
  text?: string | string[]
  speaker?: string
}

interface Group {
  heading?: string
  headingStartMs?: number
  startMs: number
  endMs: number
  blocks: Block[]
}

interface Mounted {
  host: HTMLElement
  props: { groups: Group[]; positionMs: number; activeEnabled?: boolean }
  seeks: number[]
}

function mount(props: Mounted["props"]): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = { host, props: state, seeks: [] }
  createApp({
    render: () =>
      h(TranscriptView, { ...state, onSeek: (ms: number) => m.seeks.push(ms) } as never),
  }).mount(host)
  return m
}

function sentence(text: string, start: number, speaker?: string): Block {
  return { type: "sentence", start, end: start + 1000, text, speaker }
}

const groups: Group[] = [
  {
    heading: "Opening",
    headingStartMs: 500,
    startMs: 1000,
    endMs: 4000,
    blocks: [sentence("Hare Krishna.", 1000, "Prabhupada"), sentence("Please be seated.", 2000)],
  },
  {
    startMs: 5000,
    endMs: 9000,
    blocks: [sentence("A question, please?", 5000, "Guest"), sentence("Yes.", 7000, "Prabhupada")],
  },
]

function groupEls(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".tx-group")]
}

describe("TranscriptView", () => {
  it("prints a timestamp for every group", () => {
    const m = mount({ groups, positionMs: 0 })

    expect([...m.host.querySelectorAll(".tx-time")].map((e) => e.textContent)).toEqual([
      "0:01",
      "0:05",
    ])
  })

  it("spells an hour-long lecture's timestamps out in full", () => {
    const m = mount({
      groups: [{ startMs: 3_725_000, endMs: 3_730_000, blocks: [sentence("Later.", 3_725_000)] }],
      positionMs: 0,
    })

    expect(m.host.querySelector(".tx-time")!.textContent).toBe("1:02:05")
  })

  it("seeks to the group that was tapped", () => {
    const m = mount({ groups, positionMs: 0 })

    groupEls(m.host)[1].click()

    expect(m.seeks).toEqual([5000])
  })

  it("seeks from the timestamp without also seeking from the paragraph under it", () => {
    const m = mount({ groups, positionMs: 0 })

    m.host.querySelectorAll<HTMLButtonElement>(".tx-time")[1].click()

    expect(m.seeks).toEqual([5000])
  })

  it("seeks to where a heading's section begins, not to its first sentence", () => {
    const m = mount({ groups, positionMs: 0 })

    m.host.querySelector<HTMLElement>(".tx-heading")!.click()

    expect(m.seeks).toEqual([500])
  })

  it("falls back to the group start for a heading with no start of its own", () => {
    const m = mount({
      groups: [{ heading: "Opening", startMs: 1000, endMs: 2000, blocks: [sentence("Hm.", 1000)] }],
      positionMs: 0,
    })

    m.host.querySelector<HTMLElement>(".tx-heading")!.click()

    expect(m.seeks).toEqual([1000])
  })

  it("renders a heading only where the transcript has one", () => {
    const m = mount({ groups, positionMs: 0 })

    expect([...m.host.querySelectorAll(".tx-heading")].map((e) => e.textContent)).toEqual([
      "Opening",
    ])
  })
})

describe("TranscriptView — following playback", () => {
  it("lights the group the playhead is inside and dims the rest", () => {
    const m = mount({ groups, positionMs: 2000 })

    const [first, second] = groupEls(m.host)
    expect(first.classList.contains("is-active")).toBe(true)
    expect(first.classList.contains("is-dim")).toBe(false)
    expect(second.classList.contains("is-dim")).toBe(true)
  })

  it("moves the highlight as playback advances", async () => {
    const m = mount({ groups, positionMs: 2000 })

    m.props.positionMs = 6000
    await nextTick()

    const [first, second] = groupEls(m.host)
    expect(second.classList.contains("is-active")).toBe(true)
    expect(first.classList.contains("is-dim")).toBe(true)
  })

  it("dims nothing while the playhead sits between groups", () => {
    const m = mount({ groups, positionMs: 4500 })

    for (const g of groupEls(m.host)) {
      expect(g.classList.contains("is-active")).toBe(false)
      expect(g.classList.contains("is-dim")).toBe(false)
    }
  })

  it("leaves the whole transcript plain when following is off", () => {
    const m = mount({ groups, positionMs: 2000, activeEnabled: false })

    for (const g of groupEls(m.host)) {
      expect(g.classList.contains("is-active")).toBe(false)
      expect(g.classList.contains("is-dim")).toBe(false)
    }
  })
})

describe("TranscriptView — speakers", () => {
  it("names a speaker once, where the voice changes", () => {
    const m = mount({ groups, positionMs: 0 })

    expect([...m.host.querySelectorAll(".tx-speaker")].map((e) => e.textContent?.trim())).toEqual([
      "Prabhupada:",
      "Guest:",
      "Prabhupada:",
    ])
  })

  it("carries the speaker across a group boundary without repeating it", () => {
    const m = mount({
      groups: [
        { startMs: 0, endMs: 1000, blocks: [sentence("One.", 0, "Prabhupada")] },
        { startMs: 2000, endMs: 3000, blocks: [sentence("Two.", 2000, "Prabhupada")] },
      ],
      positionMs: 0,
    })

    expect(m.host.querySelectorAll(".tx-speaker")).toHaveLength(1)
  })

  it("drops the layout-only paragraph blocks", () => {
    const m = mount({
      groups: [
        {
          startMs: 0,
          endMs: 3000,
          blocks: [
            sentence("One.", 0),
            { type: "paragraph", start: 1000, end: 1000 },
            sentence("Two.", 2000),
          ],
        },
      ],
      positionMs: 0,
    })

    expect(m.host.querySelectorAll(".tx-sentence")).toHaveLength(2)
  })

  it("shows the words of each sentence", () => {
    const m = mount({ groups, positionMs: 0 })

    expect(m.host.querySelector(".tx-group")!.textContent).toContain("Please be seated.")
  })
})
