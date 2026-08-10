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

vi.mock("@shruti/stores/usePlayerStore.js", () => ({ usePlayerStore: () => player }))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))

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

  it("stops reading the position while the page is off-screen", () => {
    const onScreen = ref(true)
    const playback = usePlaybackRowProgress(onScreen)
    const seen = watchProgress(playback)

    player.positionMs = 100
    onScreen.value = false
    // A whole lecture's worth of ticks lands while the user is on another tab.
    for (let i = 2; i <= 10; i++) player.positionMs = i * 100

    // Two runs total: the first render and the 10% tick. Going off-screen
    // recomputes to the same frozen value, and the nine ticks after it are
    // never even read.
    expect(seen).toEqual([0, 10])
    expect(playback.progressPct).toBe(10)

    onScreen.value = true

    expect(playback.progressPct).toBe(100)
  })
})
