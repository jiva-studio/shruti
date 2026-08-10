import { describe, expect, it } from "vitest"
import { reactive, watchEffect } from "vue"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import { usePlaybackRowState } from "../usePlaybackRowState.js"
import type { UiPlaybackProgress } from "../types.js"

/**
 * The row-level half of issue #1504: a playback tick must reach the row the
 * player is on and NOTHING else. `watchEffect(..., { flush: "sync" })` stands
 * in for a component's render effect — it subscribes to exactly what the
 * template reads, so a run counted here is a re-render there.
 */

function row(id: string, over: Partial<UiTrackRow> = {}): UiTrackRow {
  return {
    id,
    title: id,
    author: "",
    location: "",
    date: "",
    references: [],
    tags: [],
    state: "queued",
    progressPct: 10,
    disabled: false,
    dimmed: false,
    ...over,
  } as UiTrackRow
}

/** The overlay the app hands down, minus its `readonly` — the test drives it
 *  where the player store would. */
type MutableOverlay = { -readonly [K in keyof UiPlaybackProgress]: UiPlaybackProgress[K] }

function overlay(over: Partial<UiPlaybackProgress> = {}): MutableOverlay {
  return reactive<MutableOverlay>({
    trackId: "playing",
    state: "playing",
    progressPct: 0,
    ...over,
  })
}

/** Counts render-equivalent runs of a row's displayed state + progress. */
function watchRow(r: UiTrackRow, playback: UiPlaybackProgress) {
  const view = usePlaybackRowState(
    () => r,
    () => playback
  )
  const seen: { state: string; progressPct: number }[] = []
  watchEffect(
    () => {
      seen.push({ state: view.state.value, progressPct: view.progressPct.value })
    },
    { flush: "sync" }
  )
  return seen
}

describe("usePlaybackRowState", () => {
  it("re-renders only the playing row on a position tick", () => {
    const live = overlay()
    const playing = watchRow(row("playing", { state: "playing", progressPct: 0 }), live)
    const other = watchRow(row("other"), live)

    live.progressPct = 42

    expect(playing).toHaveLength(2)
    expect(playing[1]).toEqual({ state: "playing", progressPct: 42 })
    // The whole point: the row next to it never heard about the tick.
    expect(other).toHaveLength(1)
    expect(other[0]).toEqual({ state: "queued", progressPct: 10 })
  })

  it("keeps reporting the row's own state when nothing is playing", () => {
    const live = overlay({ trackId: null })
    const seen = watchRow(row("other", { state: "completed", progressPct: 0 }), live)

    live.progressPct = 80

    expect(seen).toEqual([{ state: "completed", progressPct: 0 }])
  })

  it("shows a re-listened lecture as playing, and as completed once the pass ends", () => {
    const live = overlay({ trackId: "t", state: "playing", progressPct: 99 })
    const seen = watchRow(row("t", { state: "completed", progressPct: 100 }), live)

    expect(seen[0]).toEqual({ state: "playing", progressPct: 99 })

    live.state = "completed"
    live.progressPct = 100

    expect(seen[seen.length - 1]).toEqual({ state: "completed", progressPct: 100 })
  })

  it("lets an in-flight download outrank live playback on the same row", () => {
    // The user re-downloaded the lecture that happens to be open in the
    // player: the row must keep showing the transfer, not the position.
    const live = overlay({ trackId: "t", progressPct: 50 })
    const seen = watchRow(row("t", { state: "downloading", progressPct: 12 }), live)

    live.progressPct = 60

    expect(seen).toEqual([{ state: "downloading", progressPct: 12 }])
  })
})
