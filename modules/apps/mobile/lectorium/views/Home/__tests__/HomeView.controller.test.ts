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
  variants: [{ language: "en", audio: { path: "a.mp3", filesize: 12_000_000 } }],
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

// The store exposes two accessors that are NOT interchangeable. While a
// download claim is held, the stored state reads "pending", so `getState`
// reports what the row is SHOWING — `useTrackUiStateMapper` needs that or
// the shimmer disappears — while `getEffectiveState` looks through the
// claim to what the row IS. Model both, so a test asserts against whichever
// one the code path under test actually consults.
let storedState = "idle"
let pendingClaim = false

const downloads = {
  hydrate: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn(() => (pendingClaim ? "pending" : storedState)),
  getEffectiveState: vi.fn(() => storedState),
  ensureDownloaded: vi.fn().mockResolvedValue(null),
}

import { useReloadOnPlayback } from "@lectorium/composables/useReloadOnPlayback.js"
import { useHomeController } from "../HomeView.controller.js"

describe("useHomeController.onSelect", () => {
  beforeEach(() => {
    toastError.mockClear()
    openTrack.mockReset()
    downloads.ensureDownloaded.mockClear()
    storedState = "idle"
    pendingClaim = false
  })

  it("toasts playbackFailed when openTrack refuses the item", async () => {
    // A rejected `openTrack` and the native drain-event notice are exclusive
    // per item (see `syncFromNative`), so the Result is the only signal the
    // row's tap went nowhere.
    openTrack.mockResolvedValue({ ok: false, error: "engine-failed" })

    await useHomeController().onSelect(TRACK_ID)

    expect(openTrack).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith("errors.playbackFailed")
  })

  it("uses the permanent message for a queued track with no audible variant", async () => {
    // Nothing gates a playlist entry on having audio, and "check your
    // connection and try again" is a loop the user can never win here.
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })

    await useHomeController().onSelect(TRACK_ID)

    expect(toastError).toHaveBeenCalledWith("errors.noAudioForLecture")
  })

  it("says nothing when playback starts", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })

    await useHomeController().onSelect(TRACK_ID)

    expect(toastError).not.toHaveBeenCalled()
  })

  it("says nothing when a failed download is retried instead of played", async () => {
    // The retry branch returns before `openTrack`; a download failure has
    // its own notice and must not also read as a playback failure. No claim
    // is held, so both accessors agree and this holds either way.
    storedState = "failed"

    await useHomeController().onSelect(TRACK_ID)

    expect(downloads.ensureDownloaded).toHaveBeenCalledOnce()
    expect(openTrack).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("funds the retry with the catalog size it already holds (#1613)", async () => {
    // Omitting it charged the storage budget a 40 MB estimate for a 12 MB
    // lecture, and the eviction credited the real size back — so every retry
    // from Home leaked the difference for the rest of the session.
    storedState = "failed"

    await useHomeController().onSelect(TRACK_ID)

    expect(downloads.ensureDownloaded).toHaveBeenCalledWith(TRACK_ID, "a.mp3", 12_000_000)
  })

  it("does not call Home on-screen until it has been entered", () => {
    // `onScreen` used to start true, so a deep link or a notification that
    // boots straight past Home left the live playback overlay ticking and the
    // heatmap polling for the whole session — the freeze engaged only after
    // one visit AND one leave (issue #1615). A page never entered is not on
    // screen, and both consumers of the flag now read the same answer.
    const { onScreen } = useHomeController()

    expect(onScreen.value).toBe(false)
    expect(vi.mocked(useReloadOnPlayback)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      undefined,
      onScreen
    )
  })

  // A masked row — stored state "failed" behind a held claim, so `getState`
  // says "pending" while `getEffectiveState` says "failed" — must also take
  // the retry branch. That case can't be asserted from this branch: the
  // controller here reads `getState`, and `getEffectiveState` arrives with
  // the pending-claim work. The mock above already models both accessors so
  // the case is a few lines to add once the controller reads the effective
  // one.
})
