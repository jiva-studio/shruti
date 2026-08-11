// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, reactive } from "vue"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import type { UiPlaybackProgress } from "../types.js"

/**
 * The collection ring (issue #1615, item 1).
 *
 * The ring answers one question — how much of this collection have I heard —
 * and the answer must not move because of a file transfer. Tapping a lecture
 * flips its row to "pending" and then "downloading" for the length of the
 * re-download, and a ring scored from `state` read both as "not listened": a
 * finished 3-lecture collection dropped to 67% on the tap itself and stayed
 * there for the transfer.
 *
 * The number is only reachable through the indicator's `value` prop — the
 * rendered radial carries no percentage in the DOM — so the indicator is
 * doubled here for something assertable. That is also why this defect cannot
 * be an e2e.
 */
vi.mock("@ui/components/tracks/state/RadialIndicator.vue", () => ({
  default: defineComponent({
    props: { value: { type: Number, default: 0 } },
    setup: (props) => () => h("div", { class: "ring", "data-value": String(props.value) }),
  }),
}))

const PlaylistGroupProgress = (await import("../PlaylistGroupProgress.vue")).default

function row(id: string, over: Partial<UiTrackRow> = {}): UiTrackRow {
  return {
    id,
    title: id,
    author: "",
    location: "",
    date: "",
    references: [],
    tags: [],
    state: "completed",
    progressPct: 0,
    listenedPct: 100,
    disabled: false,
    dimmed: false,
    ...over,
  } as UiTrackRow
}

/** Render the ring and read the percentage it was handed. */
function ringValue(rows: readonly UiTrackRow[], playback?: UiPlaybackProgress): number {
  const app = createApp(
    defineComponent({ setup: () => () => h(PlaylistGroupProgress, { rows, playback }) })
  )
  const root = document.createElement("div")
  app.mount(root)
  const value = Number(root.querySelector(".ring")?.getAttribute("data-value"))
  app.unmount()
  return value
}

describe("PlaylistGroupProgress", () => {
  const finished = [row("a"), row("b"), row("c")]

  it("holds a finished collection at full while a tapped lecture is re-fetched", () => {
    expect(ringValue(finished)).toBe(100)

    // The tap: `openTrack` claims the row synchronously, then the transfer
    // takes it over. The user has not un-listened to anything.
    const tapped = [row("a", { state: "pending" }), row("b"), row("c")]
    expect(ringValue(tapped)).toBe(100)

    const downloading = [row("a", { state: "downloading", progressPct: 12 }), row("b"), row("c")]
    expect(ringValue(downloading)).toBe(100)
  })

  it("stays full while a finished lecture is replayed from the start", () => {
    const playback = reactive({
      trackId: "a",
      state: "playing",
      progressPct: 3,
    }) as UiPlaybackProgress

    // The live overlay can only ever raise the number: three percent into a
    // re-listen is not three percent of that lecture heard.
    expect(ringValue(finished, playback)).toBe(100)
  })

  it("still reports partial listening, live and saved", () => {
    const rows = [
      row("a"),
      row("b", { state: "queued", listenedPct: 50, progressPct: 50 }),
      row("c", { state: "queued", listenedPct: 0, progressPct: 0 }),
    ]

    // 100 + 50 + 0 over three.
    expect(ringValue(rows)).toBe(50)

    // The playing lecture's live position outruns its saved one and the ring
    // follows: 100 + 50 + 90.
    const playback = reactive({
      trackId: "c",
      state: "playing",
      progressPct: 90,
    }) as UiPlaybackProgress
    expect(ringValue(rows, playback)).toBe(80)
  })

  it("is zero for a collection nothing has been heard of", () => {
    expect(ringValue([row("a", { state: "queued", listenedPct: 0, progressPct: 0 })])).toBe(0)
    expect(ringValue([])).toBe(0)
  })
})
