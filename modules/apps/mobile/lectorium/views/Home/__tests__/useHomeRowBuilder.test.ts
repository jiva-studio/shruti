import { afterEach, describe, expect, it, beforeEach, vi } from "vitest"
import { reactive, ref, watchEffect } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Issue #1504: the Home playlist used to be rebuilt once per second for as
 * long as anything was playing, because the row mapper read
 * `player.positionMs`. These tests pin the fix at its source — the row
 * computed — by counting `buildTrackRow` calls, which is the work the tick
 * used to redo for all 50 rows.
 */

let builds = 0
vi.mock("@lectorium/composables/buildTrackRow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lectorium/composables/buildTrackRow.js")>()
  return {
    buildTrackRow: (...args: Parameters<typeof actual.buildTrackRow>) => {
      builds++
      return actual.buildTrackRow(...args)
    },
  }
})
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    authorsById: new Map(),
    locationsById: new Map(),
    sourcesById: new Map(),
    tagsById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({ useDownloadStore: () => downloads }))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({ usePlayerStore: () => player }))

const PLAYING = "playing-track" as TrackId
const IDLE = "idle-track" as TrackId

function track(id: TrackId): Track {
  return {
    id,
    authorId: null,
    tagIds: [],
    references: [],
    date: "",
    variants: [{ language: "en", audio: { path: `${id}.mp3`, duration: 600_000 } }],
  } as unknown as Track
}

const player = reactive({
  trackId: PLAYING as string | null,
  positionMs: 0,
  durationMs: 600_000,
})

const DEFAULT_ENTRIES = [
  { track: track(PLAYING), item: { id: "i-playing", trackId: PLAYING } },
  { track: track(IDLE), item: { id: "i-idle", trackId: IDLE } },
]

const playlist = reactive({
  entries: [...DEFAULT_ENTRIES],
  activeEntries: [...DEFAULT_ENTRIES],
  progressMap: new Map<string, number>([["i-playing", 60_000]]),
  completedAtMap: new Map<string, number>(),
  completedTrackIds: new Set<string>(),
  getEntryByTrackId: (id: string) => playlist.entries.find((e) => e.item.trackId === id) ?? null,
  getCompletedAt: (itemId: string) => playlist.completedAtMap.get(itemId) ?? null,
  getProgressMs: (itemId: string) => playlist.progressMap.get(itemId) ?? 0,
  hasTrack: (id: string) => playlist.entries.some((e) => e.item.trackId === id),
  hasCompletedTrack: (id: string) => playlist.completedTrackIds.has(id),
})

const downloads = reactive({
  states: {} as Record<string, string>,
  progress: {} as Record<string, number>,
  getState: (id: string) => downloads.states[id] ?? "completed",
  getProgress: (id: string) => downloads.progress[id] ?? 0,
})

import { useHomeRowBuilder } from "../useHomeRowBuilder.js"

/** Counts evaluations of the `rows` computed, the way a render would. */
function watchRows(rows: { value: unknown }): number[] {
  const runs: number[] = []
  watchEffect(
    () => {
      void rows.value
      runs.push(builds)
    },
    { flush: "sync" }
  )
  return runs
}

describe("useHomeRowBuilder — playback ticks", () => {
  beforeEach(() => {
    builds = 0
    player.trackId = PLAYING
    player.positionMs = 0
    player.durationMs = 600_000
    downloads.states = {}
  })

  it("does not rebuild the list when the playback position advances", () => {
    const { rows } = useHomeRowBuilder()
    const runs = watchRows(rows)
    const before = rows.value
    const buildsAfterFirstRender = builds

    for (let sec = 1; sec <= 10; sec++) player.positionMs = sec * 1000

    expect(runs).toHaveLength(1)
    expect(builds).toBe(buildsAfterFirstRender)
    // Untouched rows keep their identity, so the children downstream
    // (usePlaylistGroups, PlaylistRow) have nothing to re-render either.
    expect(rows.value).toBe(before)
    expect(rows.value[0]).toBe(before[0])
    expect(rows.value[1]).toBe(before[1])
  })

  it("still rebuilds when something the row actually shows changes", () => {
    const { rows } = useHomeRowBuilder()
    const runs = watchRows(rows)
    const before = rows.value

    downloads.states = { [IDLE]: "downloading" }

    expect(runs).toHaveLength(2)
    expect(rows.value).not.toBe(before)
    expect(rows.value[1].state).toBe("downloading")
  })

  it("gives the playing row the SAVED progress, leaving the live one to the overlay", () => {
    // 60s of 600s stored on the playlist item; the engine is at 5 minutes.
    player.positionMs = 300_000

    const { rows } = useHomeRowBuilder()

    expect(rows.value[0].state).toBe("playing")
    expect(rows.value[0].progressPct).toBeCloseTo(10)
  })
})

/**
 * Issue #1850: the "Up Next" badges iterated `entries` — the 50-row window
 * Home has rendered — so a queue of 120 unfinished lectures showed 50, with a
 * matching understated remaining time, and both climbed as the user scrolled.
 * They read `activeEntries` now; the store loads progress + completion for the
 * whole active list at `refresh()`, so off-page items carry real derived data
 * rather than reading as unfinished-with-zero-progress.
 */
describe("useHomeRowBuilder — Up Next badges over the whole queue", () => {
  const QUEUE = 120
  const PAGE = 50
  /** Every fixture lecture is 600_000 ms = 600 s of audio. */
  const DURATION_SEC = 600

  beforeEach(() => {
    const all = Array.from({ length: QUEUE }, (_, i) => ({
      track: track(`t-${i}` as TrackId),
      item: { id: `i-${i}`, trackId: `t-${i}` as TrackId },
    }))
    playlist.activeEntries = all
    playlist.entries = all.slice(0, PAGE)
    playlist.progressMap = new Map()
    playlist.completedAtMap = new Map()
    downloads.states = {}
  })

  afterEach(() => {
    playlist.activeEntries = [...DEFAULT_ENTRIES]
    playlist.entries = [...DEFAULT_ENTRIES]
    playlist.progressMap = new Map<string, number>([["i-playing", 60_000]])
    playlist.completedAtMap = new Map()
  })

  it("counts the whole queue, not the rendered page", () => {
    const { queueCount, rows } = useHomeRowBuilder()

    expect(rows.value).toHaveLength(PAGE)
    expect(queueCount.value).toBe(QUEUE)
  })

  it("excludes an already-finished lecture that sits past the page", () => {
    playlist.completedAtMap = new Map<string, number>([
      ["i-3", 1],
      ["i-90", 1],
      ["i-119", 1],
    ])

    const { queueCount } = useHomeRowBuilder()

    expect(queueCount.value).toBe(QUEUE - 3)
  })

  it("sums the remaining time of the whole queue", () => {
    const { queueTotalSeconds } = useHomeRowBuilder()

    expect(queueTotalSeconds.value).toBe(QUEUE * DURATION_SEC)
  })

  it("subtracts off-page progress and drops off-page completions from the time", () => {
    // Half of an off-page lecture heard, another off-page one finished.
    playlist.progressMap = new Map<string, number>([["i-80", 300_000]])
    playlist.completedAtMap = new Map<string, number>([["i-100", 1]])

    const { queueTotalSeconds } = useHomeRowBuilder()

    expect(queueTotalSeconds.value).toBe((QUEUE - 1) * DURATION_SEC - DURATION_SEC / 2)
  })

  it("does not move when the rendered window widens", () => {
    const { queueCount, queueTotalSeconds } = useHomeRowBuilder()
    const count = queueCount.value
    const seconds = queueTotalSeconds.value

    // What `loadMore()` does: widen the window over the same active list.
    playlist.entries = playlist.activeEntries.slice(0, PAGE * 2)

    expect(queueCount.value).toBe(count)
    expect(queueTotalSeconds.value).toBe(seconds)
  })
})
