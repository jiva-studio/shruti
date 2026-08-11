import { describe, expect, it, beforeEach, vi } from "vitest"
import { reactive, ref, watchEffect } from "vue"

/**
 * The overlay that carries the live position for the ONE track the player is
 * on (issue #1504) — and its off-screen switch: Ionic keeps a hidden tab
 * mounted, so Home must be able to stop reading the position when the user
 * switches tabs, not merely stop showing it.
 */

const player = reactive({
  trackId: "t1" as string | null,
  positionMs: 0,
  durationMs: 1000,
})

const playlist = reactive({
  completed: new Set<string>(),
  getEntryByTrackId: (id: string) => ({ item: { id: `i-${id}` } }),
  getCompletedAt: (itemId: string) => (playlist.completed.has(itemId) ? 1 : null),
})

vi.mock("@lectorium/stores/usePlayerStore.js", () => ({ usePlayerStore: () => player }))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))

import { usePlaybackRowProgress } from "../usePlaybackRowProgress.js"

/** Counts reads of the live fields, the way the playing row's render does. */
function watchProgress(playback: { progressPct: number }): number[] {
  const seen: number[] = []
  watchEffect(() => seen.push(playback.progressPct), { flush: "sync" })
  return seen
}

describe("usePlaybackRowProgress", () => {
  beforeEach(() => {
    player.trackId = "t1"
    player.positionMs = 0
    player.durationMs = 1000
    playlist.completed.clear()
  })

  it("tracks the live position of the open track", () => {
    const playback = usePlaybackRowProgress()
    const seen = watchProgress(playback)

    player.positionMs = 250

    expect(playback.trackId).toBe("t1")
    expect(playback.state).toBe("playing")
    expect(seen).toEqual([0, 25])
  })

  it("reports a re-listened lecture as playing until the pass reaches the end", () => {
    playlist.completed.add("i-t1")
    player.positionMs = 400
    const playback = usePlaybackRowProgress()

    expect(playback.state).toBe("playing")

    player.positionMs = 1000

    expect(playback.state).toBe("completed")
  })

  it("freezes the whole overlay while the page is off-screen", () => {
    const onScreen = ref(true)
    const playback = usePlaybackRowProgress(onScreen)
    const seen = watchProgress(playback)

    player.positionMs = 100
    // Every row reads `trackId` on every render to find out whether it is the
    // playing one — that read is what the freeze has to capture.
    expect(playback.trackId).toBe("t1")

    onScreen.value = false
    // A whole lecture's worth of ticks lands while the user is on another tab…
    for (let i = 2; i <= 10; i++) player.positionMs = i * 100
    // …and then it ends, and continuous playback moves on to the next lecture,
    // which starts from the beginning.
    player.trackId = "t2"
    player.positionMs = 30

    // Two runs total: the first render and the 10% tick. Going off-screen
    // recomputes to the same frozen value, and the nine ticks after it are
    // never even read.
    expect(seen).toEqual([0, 10])
    expect(playback.progressPct).toBe(10)
    // The frozen 10% and "playing" describe t1. Handing them out under t2
    // paints the next lecture's row with the previous lecture's radial: the
    // three fields only mean anything together, so they freeze together
    // (issue #1615).
    expect(playback.trackId).toBe("t1")

    onScreen.value = true

    // Back on screen they thaw together, all three now describing t2.
    expect(playback.trackId).toBe("t2")
    expect(playback.progressPct).toBe(3)
    expect(playback.state).toBe("playing")
  })
})
