// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const toastError = vi.fn()
const openTrack = vi.fn()
const loadTrackDetail = vi.fn()

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@usecases/playback/loadTrackDetail.js", () => ({
  loadTrackDetail: (...args: unknown[]) => loadTrackDetail(...args),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ repositories: () => ({}) }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ref("en"),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@shruti/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({ openTrack }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ getEntryByTrackId: () => ({ item: { id: "i1" } }) }),
}))

import { useTrackController, type TrackControllerReturn } from "../TrackView.controller.js"

const TRACK_ID = "t1" as TrackId

const track = {
  id: TRACK_ID,
  authorId: null,
  references: [],
  variants: [{ trackId: TRACK_ID, language: "en", title: "T", audio: { path: "a.mp3" } }],
} as unknown as Track

/** Live hosts, torn down between tests. */
const mounted: { unmount: () => void }[] = []

/** Run the controller inside a real component so `onMounted` fires. */
function mountController(): TrackControllerReturn {
  let api!: TrackControllerReturn
  const Host = defineComponent({
    setup() {
      api = useTrackController({ trackId: TRACK_ID })
      return () => h("div")
    },
  })
  const app = createApp(Host)
  app.mount(document.createElement("div"))
  mounted.push(app)
  return api
}

/** Let `onMounted`'s load chain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useTrackController playback reporting", () => {
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
  })

  beforeEach(() => {
    toastError.mockClear()
    openTrack.mockReset()
    loadTrackDetail.mockReset()
    loadTrackDetail.mockResolvedValue({
      ok: true,
      value: { track, author: null, availableLanguages: ["en"] },
    })
  })

  it("toasts playbackFailed when the play button's open is refused", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "engine-failed" })
    const api = mountController()
    await settle()

    await api.onPlay()

    expect(openTrack).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledWith("errors.playbackFailed")
  })

  it("says nothing when the play button starts playback", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })
    const api = mountController()
    await settle()

    await api.onPlay()

    expect(toastError).not.toHaveBeenCalled()
  })

  it("loads the lecture on mount without starting playback", async () => {
    // Opening the screen is not a play command: the removed `?resumeFromMs=`
    // watcher had no producer app-wide, and the transcript dialog's timecoded
    // open goes straight to the player store (#1895).
    openTrack.mockResolvedValue({ ok: true, value: undefined })
    mountController()
    await settle()

    expect(loadTrackDetail).toHaveBeenCalledOnce()
    expect(openTrack).not.toHaveBeenCalled()
  })
})
