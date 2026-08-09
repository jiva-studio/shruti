import { describe, it, expect, vi, beforeEach } from "vitest"
import { ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const openTrack = vi.fn()
const TRACK_ID = "t1" as TrackId

const track = {
  id: TRACK_ID,
  authorId: null,
  locationId: null,
  references: [],
  variants: [{ trackId: TRACK_ID, language: "en", title: "T", audio: { path: "a.mp3" } }],
} as unknown as Track

const loaderError = ref<string | null>(null)

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (k: string) => `translated:${k}` }),
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ repositories: () => ({}), shareService: {} }),
}))
vi.mock("@lectorium/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: TRACK_ID, isOpen: false, close: vi.fn(), show: vi.fn() }),
}))
vi.mock("@lectorium/stores/usePlayerStore.js", () => ({
  // `trackId: null` ≠ the open transcript's track → preview mode, which is
  // the branch that calls `openTrack`.
  usePlayerStore: () => ({
    openTrack,
    trackId: null,
    positionMs: 0,
    durationMs: 0,
    playing: false,
  }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ getEntryByTrackId: () => ({ item: { id: "i1" } }) }),
}))
vi.mock("@lectorium/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ items: [] }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: vi.fn() }),
}))
vi.mock("@lectorium/stores/useChatStore.js", () => ({ useChatStore: () => ({}) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (_key: string, fallback: unknown) => ref(fallback),
}))
vi.mock("@lectorium/composables/useTranscriptSystemBars.js", () => ({
  useTranscriptSystemBars: vi.fn(),
}))
vi.mock("../transcript/useTranscriptHydration.js", () => ({
  useTranscriptHydration: () => ({
    title: ref("T"),
    author: ref("A"),
    authorEntity: ref(null),
    track: ref(track),
    availableLanguages: ref(["en"]),
    activeLanguages: ref(["en"]),
    hydrate: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }),
}))
vi.mock("../transcript/useTranscriptLoader.js", () => ({
  useTranscriptLoader: () => ({
    error: loaderError,
    isLoading: ref(false),
    transcripts: ref([]),
    reload: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock("../transcript/useTranscriptSelectionActions.js", () => ({
  useTranscriptSelectionActions: () => ({ perform: vi.fn() }),
}))

import { useTranscriptDialogController } from "../useTranscriptDialogController.js"

describe("useTranscriptDialogController.onChapterSeek — preview mode", () => {
  beforeEach(() => {
    loaderError.value = null
    openTrack.mockReset()
  })

  it("shows a translated message when openTrack refuses, not a raw error code", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "engine-failed" })

    await useTranscriptDialogController().onChapterSeek(12000)

    // The regression this guards: the site used to render the hardcoded
    // English `Could not start playback: engine-failed`.
    expect(loaderError.value).toBe("translated:errors.playbackFailed")
    expect(loaderError.value).not.toContain("engine-failed")
  })

  it("uses the same message for a track with no audible variant", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })

    await useTranscriptDialogController().onChapterSeek(12000)

    expect(loaderError.value).toBe("translated:errors.playbackFailed")
  })

  it("leaves the banner clear when playback starts", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })

    await useTranscriptDialogController().onChapterSeek(12000)

    expect(openTrack).toHaveBeenCalledOnce()
    expect(loaderError.value).toBeNull()
  })
})
