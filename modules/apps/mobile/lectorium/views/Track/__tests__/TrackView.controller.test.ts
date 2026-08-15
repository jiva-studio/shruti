// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const toastError = vi.fn()
const openTrack = vi.fn()
const loadTrackDetail = vi.fn()

// Reactive, because the controller WATCHES `route.query.resumeFromMs`: a
// second chapter tap into the same lecture keeps the pathname stable and
// changes nothing but the query (#1856).
const routeQuery = ref<Record<string, string>>({})

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("vue-router", () => ({
  useRoute: () => ({
    get query(): Record<string, string> {
      return routeQuery.value
    },
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), success: vi.fn() }),
}))
vi.mock("@usecases/playback/loadTrackDetail.js", () => ({
  loadTrackDetail: (...args: unknown[]) => loadTrackDetail(...args),
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ repositories: () => ({}) }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ref("en"),
}))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({ openTrack }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
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

/** Live hosts, torn down between tests: the controller's query watcher
 *  outlives the test that mounted it otherwise, and every later navigation
 *  would fan out to all of them. */
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

/** Let `onMounted`'s load chain — and the query watcher — settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("useTrackController playback reporting", () => {
  afterEach(() => {
    for (const app of mounted.splice(0)) app.unmount()
  })

  beforeEach(() => {
    routeQuery.value = {}
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

  it("toasts playbackFailed when the deep-link auto-open is refused", async () => {
    // `?resumeFromMs=…` (a chat citation chip) opens the track without the
    // user pressing anything — and without the `hasAudio` gate the button
    // has, so this is the path where a refusal is most likely.
    routeQuery.value = { resumeFromMs: "12000" }
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })
    mountController()
    await settle()

    expect(openTrack).toHaveBeenCalledWith(expect.objectContaining({ resumeFromMs: 12000 }))
    expect(toastError).toHaveBeenCalledWith("errors.noAudioForLecture")
  })

  it("says nothing when the deep-link auto-open succeeds", async () => {
    routeQuery.value = { resumeFromMs: "12000" }
    openTrack.mockResolvedValue({ ok: true, value: undefined })
    mountController()
    await settle()

    expect(openTrack).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("honours a second chapter tap while the view stays mounted", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })
    routeQuery.value = { resumeFromMs: "12000" }
    mountController()
    await settle()

    expect(openTrack).toHaveBeenCalledWith(expect.objectContaining({ resumeFromMs: 12000 }))

    // Same `track/:trackId` path, a different chapter: Ionic reuses the view
    // item, so neither `setup` nor `onMounted` runs again and the only thing
    // that changed is the query. Reading it once dropped this tap entirely.
    routeQuery.value = { resumeFromMs: "480000" }
    await settle()

    expect(openTrack).toHaveBeenCalledTimes(2)
    expect(openTrack).toHaveBeenLastCalledWith(expect.objectContaining({ resumeFromMs: 480000 }))
    // The track detail is loaded once and reused, not re-fetched per tap.
    expect(loadTrackDetail).toHaveBeenCalledOnce()
  })

  it("stays put when a navigation carries no timecode", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })
    routeQuery.value = { resumeFromMs: "12000" }
    mountController()
    await settle()
    openTrack.mockClear()

    routeQuery.value = {}
    await settle()

    expect(openTrack).not.toHaveBeenCalled()
  })
})
