import { describe, it, expect, vi, beforeEach } from "vitest"
import { ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const toastError = vi.fn()
const toastInfo = vi.fn()
const submit = vi.fn()
const status = vi.fn()
const TRACK_ID = "t1" as TrackId

/** Mutable per-case inputs. Each is a module-level ref the mocks close over, so
 *  a case can describe its own user (interface language, library languages) and
 *  track (which transcripts already exist) without re-mocking the world. */
const appLanguage = ref("en")
const libraryLanguages = ref<string[]>(["en"])
const storedLanguages = ref<string[]>(["en"])
const libraryItems = ref<unknown[]>([])

const track = {
  id: TRACK_ID,
  authorId: null,
  locationId: null,
  references: [],
  variants: [{ trackId: TRACK_ID, language: "en", title: "T", audio: { path: "a.mp3" } }],
} as unknown as Track

// Renders the interpolation params into the key so an assertion can see WHICH
// language a message named — the whole point of the change under test.
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `translated:${k}:${JSON.stringify(params)}` : `translated:${k}`,
  }),
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, show: vi.fn(), info: toastInfo, action: vi.fn() }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({}),
    shareService: {},
    ingestClient: { submit, status },
  }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({ requestSync: vi.fn() }))
vi.mock("@shruti/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@shruti/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: TRACK_ID, isOpen: false, close: vi.fn(), show: vi.fn() }),
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
  usePlaylistStore: () => ({ getEntryByTrackId: () => ({ item: { id: "i1" } }) }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ items: libraryItems.value }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({
  useNotesStore: () => ({ refresh: vi.fn() }),
}))
vi.mock("@shruti/stores/useChatStore.js", () => ({ useChatStore: () => ({}) }))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => appLanguage }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => libraryLanguages,
}))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (_key: string, fallback: unknown) => ref(fallback),
}))
vi.mock("@shruti/composables/useTranscriptSystemBars.js", () => ({
  useTranscriptSystemBars: vi.fn(),
}))
vi.mock("../transcript/useTranscriptHydration.js", () => ({
  useTranscriptHydration: () => ({
    title: ref("T"),
    author: ref("A"),
    authorEntity: ref(null),
    track: ref(track),
    availableLanguages: storedLanguages,
    activeLanguages: ref(["en"]),
    hydrate: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }),
}))
vi.mock("../transcript/useTranscriptLoader.js", () => ({
  useTranscriptLoader: () => ({
    errorKey: ref<string | null>(null),
    isLoading: ref(false),
    transcripts: ref([]),
    reload: vi.fn().mockResolvedValue(undefined),
    failedLanguages: ref([]),
  }),
}))
vi.mock("../transcript/useTranscriptSelectionActions.js", () => ({
  useTranscriptSelectionActions: () => ({ perform: vi.fn() }),
}))

import { useTranscriptDialogController } from "../useTranscriptDialogController.js"

/** The library membership that makes the open track a personal-library one. */
function membership(languages: string[]) {
  return {
    id: "m1",
    trackId: TRACK_ID,
    titleRaw: "T",
    variants: languages.map((language) => ({ language })),
  }
}

/** Codes of the chips offered as translation targets (the "ghost" chips). */
function ghostCodes(): string[] {
  const dialog = useTranscriptDialogController()
  return dialog.availableLanguages.value.filter((l) => l.available === false).map((l) => l.code)
}

/**
 * Choosing the target language of a translation.
 *
 * The chip used to hardcode a single target — the interface language — so the
 * only lever the user had over what a translation produced was to change the
 * language of the whole app. These cases pin the offer itself: which languages
 * are proposed, which are withheld, and what the user is told about the one
 * they picked.
 *
 * Scope is the personal library. A catalog lecture is still not offered a
 * translation at all (no membership → no targets), because a catalog
 * translation has nowhere to be written until #1711 lands.
 */
describe("useTranscriptDialogController — choosing a translation target", () => {
  beforeEach(() => {
    toastError.mockReset()
    submit.mockReset()
    status.mockReset()
    submit.mockResolvedValue({ run_id: "run-1" })
    appLanguage.value = "en"
    libraryLanguages.value = ["en"]
    storedLanguages.value = ["en"]
    libraryItems.value = [membership(["en"])]
  })

  it("offers every library language, not only the interface language", () => {
    // The user reads three languages and has this lecture in English only.
    appLanguage.value = "en"
    libraryLanguages.value = ["en", "ru", "de"]

    // Before: exactly one chip, `en` — and here not even that, `en` being the
    // source. The user could not ask for `ru` or `de` at all.
    expect(ghostCodes()).toEqual(["ru", "de"])
  })

  it("puts the interface language first among the targets", () => {
    // It is the likeliest pick, and it is the one the old single chip offered.
    appLanguage.value = "de"
    libraryLanguages.value = ["ru", "de"]

    expect(ghostCodes()).toEqual(["de", "ru"])
  })

  it("never offers a language the track already has", () => {
    // `ru` is already a stored transcript: offering it would let the user spend
    // a run producing a second `ru` variant of the same lecture.
    storedLanguages.value = ["en", "ru"]
    libraryItems.value = [membership(["en", "ru"])]
    libraryLanguages.value = ["en", "ru", "de"]

    expect(ghostCodes()).toEqual(["de"])
  })

  it("never offers the language it would translate from", () => {
    appLanguage.value = "en"
    libraryLanguages.value = ["en"]

    // `en` is the source — the whole candidate list collapses to nothing.
    expect(ghostCodes()).toEqual([])
  })

  it("offers a language only once when it is both the interface and a library language", () => {
    appLanguage.value = "ru"
    libraryLanguages.value = ["en", "ru"]

    expect(ghostCodes()).toEqual(["ru"])
  })

  it("offers nothing on a catalog lecture", () => {
    // No membership → not a personal-library track. Unchanged by this work and
    // asserted so lifting the gate can't happen by accident: the catalog half
    // of the issue is blocked on #1711.
    libraryItems.value = []
    libraryLanguages.value = ["en", "ru", "de"]

    expect(ghostCodes()).toEqual([])
  })

  it("dispatches the language the user picked", () => {
    // Regression guard: the dispatch always forwarded its argument, so this
    // held before the change too. It is the contract the new chips rely on.
    appLanguage.value = "en"
    libraryLanguages.value = ["en", "de"]

    void useTranscriptDialogController().onTranslateLanguage("de")

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ op: "translate", source_lang: "en", target_lang: "de" })
    )
  })

  it("refuses a target the track already has", () => {
    // Reachable without a stale UI: a run can finish and sync while its chip is
    // still on screen. Before, the guard only rejected the SOURCE language, so
    // this went through and produced a duplicate variant.
    storedLanguages.value = ["en", "ru"]
    libraryItems.value = [membership(["en", "ru"])]
    libraryLanguages.value = ["en", "ru"]

    void useTranscriptDialogController().onTranslateLanguage("ru")

    expect(submit).not.toHaveBeenCalled()
  })

  it("spins only the chip whose translation is running", async () => {
    // Two targets, one run: the other must stay tappable rather than the whole
    // row locking up.
    appLanguage.value = "ru"
    libraryLanguages.value = ["ru", "de"]
    status.mockResolvedValue({ state: "running" })

    const dialog = useTranscriptDialogController()
    void dialog.onTranslateLanguage("ru")
    await Promise.resolve()
    await Promise.resolve()

    const busy = dialog.availableLanguages.value.filter((l) => l.busy).map((l) => l.code)
    expect(busy).toEqual(["ru"])
  })
})

/**
 * The messages a translation ends in. They were written for a single implied
 * target (#1589) and said only "the translation" — which, once the user picks a
 * language and can have two runs going at once, names nothing.
 */
describe("useTranscriptDialogController — reporting a chosen translation", () => {
  beforeEach(() => {
    toastError.mockReset()
    toastInfo.mockReset()
    submit.mockReset()
    status.mockReset()
    submit.mockResolvedValue({ run_id: "run-1" })
    appLanguage.value = "en"
    libraryLanguages.value = ["en", "de"]
    storedLanguages.value = ["en"]
    libraryItems.value = [membership(["en"])]
  })

  it("names the language in the failure message", async () => {
    status.mockResolvedValue({ state: "failed" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("de")
      await vi.advanceTimersByTimeAsync(3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastError).toHaveBeenCalledWith('translated:errors.translationFailed:{"language":"DE"}')
  })

  // #1845: the catch PREFERRED `err.message` over the key it already had, so a
  // translation the ingest API refused told a Russian reader "ingest api
  // responded 500".
  it("keeps a raw server message out of the failure toast", async () => {
    submit.mockRejectedValue(new Error("ingest api responded 500"))

    await useTranscriptDialogController().onTranslateLanguage("de")

    expect(toastError).toHaveBeenCalledWith('translated:errors.translationFailed:{"language":"DE"}')
  })

  it("names the language in the still-running message", async () => {
    status.mockResolvedValue({ state: "running" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("de")
      // 120 polls, 3s apart — the poll gives up, the run does not.
      await vi.advanceTimersByTimeAsync(120 * 3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastInfo).toHaveBeenCalledWith(
      'translated:errors.translationStillRunning:{"language":"DE"}'
    )
    // Not the error channel: nothing has gone wrong, and a red toast under a
    // sentence that ends "it will appear once it's ready" contradicts itself.
    expect(toastError).not.toHaveBeenCalled()
  })

  it("names the language when the run was cancelled, and does not call it a failure", async () => {
    // A third outcome, not a shade of the second: a cancelled run was stopped
    // deliberately, so "failed — try again later" is both wrong and an
    // invitation to spend another run on something nobody wanted.
    status.mockResolvedValue({ state: "cancelled" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("de")
      await vi.advanceTimersByTimeAsync(3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastInfo).toHaveBeenCalledWith(
      'translated:errors.translationCancelled:{"language":"DE"}'
    )
    expect(toastError).not.toHaveBeenCalled()
  })
})
