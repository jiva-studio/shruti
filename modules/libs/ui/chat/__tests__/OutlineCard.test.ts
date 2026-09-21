// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import OutlineCard from "../OutlineCard.vue"

interface Item {
  startMs: number
  title: string
}

interface Picked {
  trackId: string
  item: Item
  nextItem: Item | null
}

interface Mounted {
  host: HTMLElement
  props: { trackId: string; items: Item[]; trackTitle?: string; disabled?: boolean }
  picks: Picked[]
  opens: { trackId: string; startMs: number }[]
  rows: () => HTMLButtonElement[]
}

function mount(props: Mounted["props"]): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m: Mounted = {
    host,
    props: state,
    picks: [],
    opens: [],
    rows: () => [...host.querySelectorAll<HTMLButtonElement>(".chapter")],
  }
  createApp({
    render: () =>
      h(OutlineCard, {
        ...state,
        "onPick-chapter": (args: Picked) => m.picks.push(args),
        "onOpen-lecture": (args: { trackId: string; startMs: number }) => m.opens.push(args),
      }),
  }).mount(host)
  return m
}

function outline(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ startMs: i * 60_000, title: `Chapter ${i + 1}` }))
}

describe("OutlineCard", () => {
  it("renders nothing for a lecture with no outline", () => {
    const m = mount({ trackId: "t1", items: [] })

    expect(m.host.querySelector(".outline-card")).toBeNull()
  })

  it("lists every chapter with its timestamp", () => {
    const m = mount({ trackId: "t1", items: outline(3) })

    expect([...m.host.querySelectorAll(".ts")].map((e) => e.textContent)).toEqual([
      "00:00",
      "01:00",
      "02:00",
    ])
    expect([...m.host.querySelectorAll(".cap")].map((e) => e.textContent)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
    ])
  })

  it("spells an hour out in a long lecture's timestamps", () => {
    const m = mount({ trackId: "t1", items: [{ startMs: 3_725_000, title: "Late" }] })

    expect(m.host.querySelector(".ts")!.textContent).toBe("1:02:05")
  })

  it("falls back to zero for a nonsense timestamp", () => {
    const m = mount({ trackId: "t1", items: [{ startMs: -1, title: "Bad" }] })

    expect(m.host.querySelector(".ts")!.textContent).toBe("00:00")
  })

  it("shows only the first seven chapters until asked for more", async () => {
    const m = mount({ trackId: "t1", items: outline(10) })

    expect(m.rows()).toHaveLength(7)
    expect(m.host.querySelector(".expand")!.textContent).toBe("+3")

    m.host.querySelector<HTMLButtonElement>(".expand")!.click()
    await nextTick()

    expect(m.rows()).toHaveLength(10)
    expect(m.host.querySelector(".expand")).toBeNull()
  })

  it("offers no expander for an outline that already fits", () => {
    const m = mount({ trackId: "t1", items: outline(7) })

    expect(m.host.querySelector(".expand")).toBeNull()
  })

  it("carries the following chapter along so the host can bound the recap", () => {
    const m = mount({ trackId: "t1", items: outline(3) })

    m.rows()[0].click()

    expect(m.picks).toEqual([
      {
        trackId: "t1",
        item: { startMs: 0, title: "Chapter 1" },
        nextItem: { startMs: 60_000, title: "Chapter 2" },
      },
    ])
  })

  it("has no following chapter for the last one", () => {
    const m = mount({ trackId: "t1", items: outline(3) })

    m.rows()[2].click()

    expect(m.picks[0].nextItem).toBeNull()
  })

  it("picks from the full outline, not just the visible slice", async () => {
    const m = mount({ trackId: "t1", items: outline(10) })

    m.host.querySelector<HTMLButtonElement>(".expand")!.click()
    await nextTick()
    m.rows()[9].click()

    expect(m.picks[0].item.title).toBe("Chapter 10")
  })

  it("refuses chapter taps while the quota is spent", () => {
    const m = mount({ trackId: "t1", items: outline(3), disabled: true })

    expect(m.rows()[0].disabled).toBe(true)

    m.rows()[0].click()

    expect(m.picks).toEqual([])
  })

  it("still opens the lecture while chapter taps are refused", () => {
    const m = mount({ trackId: "t1", items: outline(3), trackTitle: "BG 2.13", disabled: true })

    m.host.querySelector<HTMLButtonElement>(".head")!.click()

    expect(m.opens).toEqual([{ trackId: "t1", startMs: 0 }])
  })

  it("hides the header for a lecture whose title has not loaded", () => {
    const m = mount({ trackId: "t1", items: outline(3) })

    expect(m.host.querySelector(".head")).toBeNull()
  })
})
