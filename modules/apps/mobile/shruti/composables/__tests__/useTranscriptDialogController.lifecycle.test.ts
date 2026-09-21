import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope, nextTick, ref, type EffectScope } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

const TRACK_ID = "t1" as TrackId

const toastInfo = vi.fn()
const toastError = vi.fn()
const openTrackId = ref<TrackId | null>(TRACK_ID)
const dialogOpen = ref(true)
const availableLanguages = ref<LanguageCode[]>(["en"])
const activeLanguages = ref<LanguageCode[]>(["en"])
const failedLanguages = ref<LanguageCode[]>([])
const loaderErrorKey = ref<string | null>(null)
const loaderIsLoading = ref(false)
const hydratedTrack = ref<Track | null>(null)

const track: Track = {
  id: TRACK_ID,
  authorId: null,
  locationId: null,
  date: "2004-03-17",
  hidden: false,
  references: [],
  tagIds: [],
  topicIds: [],
  variants: [
    {
      trackId: TRACK_ID,
      language: "en",
      title: "Lecture on surrender",
      audios: [],
      audio: { path: "a.mp3", filesize: 1, duration: 60_000, kind: "original" },
      transcript: null,
      outline: null,
      description: null,
    },
  ],
}

const repositories = {
  tracks: { name: "tracks" },
  authors: { name: "authors" },
  transcripts: { name: "transcripts" },
  notes: {
    listByTrack: async () => [],
  },
  unitOfWork: { run: async (fn: (tx: unknown) => unknown) => fn({}) },
}

/** Track ids hydrated, and the `(trackId, languages)` each reload asked for. */
let hydrations: (TrackId | undefined)[] = []
let reloads: [TrackId | undefined, readonly string[]][] = []
let resets = 0
let haptics: string[] = []
let hydrationOptions: { getRepos: () => unknown } | null = null
let loaderOptions: { getTranscripts: () => unknown } | null = null

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `translated:${key}:${JSON.stringify(params)}` : `translated:${key}`,
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, info: toastInfo, show: vi.fn(), action: vi.fn() }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => repositories,
    shareService: { copyToClipboard: async () => {}, share: async () => {} },
    ingestClient: { submit: vi.fn(), status: vi.fn() },
    haptics: {
      impact: async (style: string) => {
        haptics.push(style)
      },
    },
  }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync: vi.fn() }))
vi.mock("@shruti/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@shruti/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({
    get trackId() {
      return openTrackId.value
    },
    get open() {
      return dialogOpen.value
    },
    close: () => {
      dialogOpen.value = false
    },
  }),
}))
vi.mock("@shruti/stores/usePlayerStore.js", () => ({
  usePlayerStore: () => ({
    openTrack: vi.fn(),
    trackId: null,
    positionMs: 0,
    durationMs: 0,
    playing: false,
  }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ getEntryByTrackId: () => undefined }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ items: [] }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => {},
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: async () => {} }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({ useChatStore: () => ({}) }))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref<string[]>(["en"]),
}))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (_key: string, fallback: unknown) => ref(fallback),
}))
vi.mock("@shruti/composables/useTranscriptSystemBars.js", () => ({
  useTranscriptSystemBars: () => {},
}))
vi.mock("../transcript/useTranscriptHydration.js", () => ({
  useTranscriptHydration: (options: { getRepos: () => unknown }) => {
    hydrationOptions = options
    return {
      title: ref("Lecture on surrender"),
      author: ref("Sadhu"),
      authorEntity: ref(null),
      track: hydratedTrack,
      availableLanguages,
      activeLanguages,
      hydrate: async (id: TrackId) => {
        hydrations.push(id)
        hydratedTrack.value = track
      },
      reset: () => {
        resets++
        hydratedTrack.value = null
      },
    }
  },
}))
vi.mock("../transcript/useTranscriptLoader.js", () => ({
  useTranscriptLoader: (options: { getTranscripts: () => unknown }) => {
    loaderOptions = options
    return {
      errorKey: loaderErrorKey,
      isLoading: loaderIsLoading,
      transcripts: ref([]),
      failedLanguages,
      reload: async (id: TrackId | undefined, languages: readonly string[]) => {
        reloads.push([id, [...languages]])
      },
    }
  },
}))

import { useTranscriptDialogController } from "../useTranscriptDialogController.js"

let scope: EffectScope | null = null

/** One controller per case, in its own scope — its watchers outlive the call. */
async function openController() {
  scope = effectScope()
  const dialog = scope.run(() => useTranscriptDialogController())!
  await nextTick()
  await nextTick()
  return dialog
}

describe("useTranscriptDialogController — opening, closing and reloading", () => {
  beforeEach(() => {
    openTrackId.value = TRACK_ID
    dialogOpen.value = true
    availableLanguages.value = ["en"]
    activeLanguages.value = ["en"]
    failedLanguages.value = []
    loaderErrorKey.value = null
    loaderIsLoading.value = false
    hydratedTrack.value = null
    hydrations = []
    reloads = []
    resets = 0
    haptics = []
    hydrationOptions = null
    loaderOptions = null
    toastInfo.mockReset()
    toastError.mockReset()
  })

  afterEach(() => {
    scope?.stop()
    scope = null
  })

  describe("the repositories it reads through", () => {
    it("hands hydration the catalog repositories", async () => {
      await openController()

      expect(hydrationOptions!.getRepos()).toEqual({
        tracks: repositories.tracks,
        authors: repositories.authors,
        transcripts: repositories.transcripts,
      })
    })

    it("hands the loader the transcript repository", async () => {
      await openController()

      expect(loaderOptions!.getTranscripts()).toBe(repositories.transcripts)
    })
  })

  describe("the open track", () => {
    it("hydrates it and loads its text", async () => {
      await openController()

      expect(hydrations).toEqual([TRACK_ID])
      expect(reloads).toEqual([[TRACK_ID, ["en"]]])
    })

    it("clears the reader when the dialog has no track", async () => {
      const dialog = await openController()
      reloads = []

      openTrackId.value = null
      await nextTick()
      await nextTick()

      expect(resets).toBe(1)
      expect(reloads).toEqual([[undefined, []]])
      expect(dialog.blockGroups.value).toEqual([])
    })

    it("re-reads the text when the chosen languages change", async () => {
      await openController()
      reloads = []

      activeLanguages.value = ["en", "ru"]
      await nextTick()

      expect(reloads).toEqual([[TRACK_ID, ["en", "ru"]]])
    })

    it("does not re-read the text for a closed dialog", async () => {
      openTrackId.value = null
      await openController()
      reloads = []

      activeLanguages.value = ["ru"]
      await nextTick()

      expect(reloads).toEqual([])
    })
  })

  describe("closing", () => {
    it("reports the store's open state", async () => {
      const dialog = await openController()

      expect(dialog.isOpen.value).toBe(true)
      dialogOpen.value = false
      expect(dialog.isOpen.value).toBe(false)
    })

    it("closes the store when the sheet is dismissed", async () => {
      const dialog = await openController()

      dialog.isOpen.value = false

      expect(dialogOpen.value).toBe(false)
    })

    it("leaves the store alone when the sheet reports itself open", async () => {
      const dialog = await openController()
      dialogOpen.value = false

      dialog.isOpen.value = true

      expect(dialogOpen.value).toBe(false)
    })

    it("closes on the close button", async () => {
      const dialog = await openController()

      dialog.onClose()

      expect(dialogOpen.value).toBe(false)
    })
  })

  describe("the language selector", () => {
    it("stays single-choice for a track with one transcript", async () => {
      const dialog = await openController()

      expect(dialog.allowMultipleLanguages.value).toBe(false)
    })

    it("allows a multi-language track to show both", async () => {
      availableLanguages.value = ["en", "ru"]
      const dialog = await openController()

      expect(dialog.allowMultipleLanguages.value).toBe(true)
    })

    it("buzzes when the user starts picking", async () => {
      const dialog = await openController()

      dialog.onPickStart()

      expect(haptics).toEqual(["light"])
    })
  })

  describe("what the reader shows instead of the text", () => {
    it("says nothing while the document loaded", async () => {
      const dialog = await openController()

      expect(dialog.error.value).toBeNull()
    })

    it("composes the load failure in the reader's locale", async () => {
      const dialog = await openController()

      loaderErrorKey.value = "errors.transcriptUnavailable"

      expect(dialog.error.value).toBe("translated:errors.transcriptUnavailable")
    })

    it("reports an empty track only once hydration has settled", async () => {
      availableLanguages.value = []
      loaderIsLoading.value = true
      const dialog = await openController()
      expect(dialog.hasNoTranscripts.value).toBe(false)

      loaderIsLoading.value = false

      expect(dialog.hasNoTranscripts.value).toBe(true)
    })

    it("does not call a failed load an empty track", async () => {
      availableLanguages.value = []
      const dialog = await openController()

      loaderErrorKey.value = "errors.transcriptUnavailable"

      expect(dialog.hasNoTranscripts.value).toBe(false)
    })
  })

  describe("one language of several failing", () => {
    it("names it in a notice and keeps the reader on screen", async () => {
      const dialog = await openController()

      failedLanguages.value = ["ru"]
      await nextTick()

      expect(toastInfo).toHaveBeenCalledWith(
        'translated:errors.transcriptLanguageUnavailable:{"language":"RU"}'
      )
      expect(dialog.error.value).toBeNull()
    })

    it("says nothing when every language loaded", async () => {
      await openController()

      failedLanguages.value = []
      await nextTick()

      expect(toastInfo).not.toHaveBeenCalled()
    })
  })
})
