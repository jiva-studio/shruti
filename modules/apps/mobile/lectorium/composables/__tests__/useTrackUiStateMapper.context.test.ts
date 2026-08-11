import { describe, expect, it, beforeEach, vi } from "vitest"
import { reactive } from "vue"
import type { Track } from "@lib/domain/track.js"

/**
 * `toUiRow` reads the SAME `context` as `mapRows`.
 *
 * The Search landing builds most of its shelves through `mapRows(…, { context:
 * "discovery" })` but built the topic shelves one row at a time through
 * `toUiRow`, which had no way to say so — so the same lecture rendered a
 * progress radial in one shelf and a checkmark two sections above it (#1615).
 */

const player = reactive({ trackId: null as string | null })

const playlist = reactive({
  entries: [] as unknown[],
  progressMap: {},
  completedAtMap: {},
  completedTrackIds: new Set<string>(),
  progress: new Map<string, number>(),
  completed: new Set<string>(),
  getEntryByTrackId: (id: string) =>
    playlist.progress.has(id) ? { item: { id: `i-${id}` } } : undefined,
  getCompletedAt: () => null,
  getProgressMs: (itemId: string) => playlist.progress.get(itemId.replace(/^i-/, "")) ?? 0,
  hasTrack: (id: string) => playlist.progress.has(id),
  hasCompletedTrack: (id: string) => playlist.completed.has(id),
})

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "en" }),
}))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ({ value: ["en"] }),
}))
vi.mock("@lectorium/composables/buildTrackRow.js", () => ({
  buildTrackRow: (track: Track, opts: { state: string; progressPct: number }) => ({
    id: track.id,
    state: opts.state,
    progressPct: opts.progressPct,
  }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    authorsById: new Map(),
    locationsById: new Map(),
    sourcesById: new Map(),
    tagsById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({
    states: {},
    progress: {},
    getState: () => "none",
    getProgress: () => 0,
  }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({ usePlayerStore: () => player }))

import { useTrackUiStateMapper } from "../useTrackUiStateMapper.js"

const TRACK = { id: "t1", variants: [] } as unknown as Track

describe("useTrackUiStateMapper — toUiRow honours the row context", () => {
  beforeEach(() => {
    player.trackId = null
    playlist.progress.clear()
    playlist.completed.clear()
  })

  it("folds the playing track to the binary added state on a discovery surface", () => {
    playlist.progress.set("t1", 5_000)
    player.trackId = "t1"
    const mapper = useTrackUiStateMapper()

    // The Home queue keeps the radial…
    expect(mapper.toUiRow(TRACK).state).toBe("playing")
    // …while a Search shelf shows the same binary badge as the shelves beside it.
    expect(mapper.toUiRow(TRACK, { context: "discovery" }).state).toBe("added")
  })

  it("folds a track with saved progress the same way", () => {
    playlist.progress.set("t1", 5_000)
    const mapper = useTrackUiStateMapper()

    expect(mapper.toUiRow(TRACK).state).toBe("queued")
    expect(mapper.toUiRow(TRACK, { context: "discovery" }).state).toBe("added")
  })

  it("agrees with mapRows given the same context", () => {
    playlist.progress.set("t1", 5_000)
    playlist.completed.add("t1")
    const mapper = useTrackUiStateMapper()
    const mapped = mapper.mapRows(() => [TRACK], { context: "discovery" })

    expect(mapper.toUiRow(TRACK, { context: "discovery" }).state).toBe(mapped.value[0]!.state)
    expect(mapped.value[0]!.state).toBe("completed")
  })
})
