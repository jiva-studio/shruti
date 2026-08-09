import { describe, it, expect, vi, beforeEach } from "vitest"
import { ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const toastError = vi.fn()
const openTrack = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ref("en"),
}))
vi.mock("@lectorium/composables/useActivityHeatmap.js", () => ({
  useActivityHeatmap: () => ({
    days: ref([]),
    currentStreak: ref(0),
    completedCount: ref(0),
    totalListenedSeconds: ref(0),
    reload: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock("@lectorium/composables/useReloadOnPlayback.js", () => ({
  useReloadOnPlayback: vi.fn(),
}))
vi.mock("../useHomeRowBuilder.js", () => ({
  useHomeRowBuilder: () => ({ rows: ref([]), queueCount: ref(0), queueTotalSeconds: ref(0) }),
}))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({ openTrack, playing: false }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => playlist,
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => downloads,
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    error: null,
    authorsById: new Map(),
  }),
}))

const TRACK_ID = "t1" as TrackId

const track = {
  id: TRACK_ID,
  authorId: null,
  variants: [{ language: "en", audio: { path: "a.mp3" } }],
} as unknown as Track

const playlist = {
  entries: [{ track, item: { id: "i1" } }],
  isLoading: false,
  error: null,
  hasMore: false,
  ensureLoaded: vi.fn().mockResolvedValue(undefined),
  prefetchAll: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn().mockResolvedValue(undefined),
  archiveByTrackId: vi.fn().mockResolvedValue(undefined),
}

const downloads = {
  hydrate: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue("idle"),
  ensureDownloaded: vi.fn().mockResolvedValue(null),
}

import { useHomeController } from "../HomeView.controller.js"

describe("useHomeController.onSelect", () => {
  beforeEach(() => {
    toastError.mockClear()
    openTrack.mockReset()
  })

  it("toasts playbackFailed when openTrack refuses the item", async () => {
    // `openTrack` returning ok:false means the engine never accepted the
    // item, so the native queue-drain toast can never fire for it — the
    // Result is the only signal the row's tap went nowhere.
    openTrack.mockResolvedValue({ ok: false, error: "engine-failed" })

    await useHomeController().onSelect(TRACK_ID)

    expect(openTrack).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith("errors.playbackFailed")
  })

  it("uses the same message for a track with no audible variant", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })

    await useHomeController().onSelect(TRACK_ID)

    expect(toastError).toHaveBeenCalledWith("errors.playbackFailed")
  })

  it("says nothing when playback starts", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })

    await useHomeController().onSelect(TRACK_ID)

    expect(toastError).not.toHaveBeenCalled()
  })

  it("says nothing when a failed download is retried instead of played", async () => {
    // The retry branch returns before `openTrack`; a download failure has
    // its own notice and must not also read as a playback failure.
    downloads.getState.mockReturnValueOnce("failed")

    await useHomeController().onSelect(TRACK_ID)

    expect(openTrack).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})
