import { describe, it, expect, vi, beforeEach } from "vitest"
import { ref } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { TrackId } from "@lib/domain/core.js"

const openTrack = vi.fn()
const toastError = vi.fn()
const toastInfo = vi.fn()
const submit = vi.fn()
const status = vi.fn()
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
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ getEntryByTrackId: () => ({ item: { id: "i1" } }) }),
}))
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  // A personal-library membership for the open track — the precondition for the
  // ghost language chip that requests an on-demand translation.
  useLibraryStore: () => ({
    items: [{ id: "m1", trackId: TRACK_ID, titleRaw: "T", variants: [{ language: "en" }] }],
  }),
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
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  // `ru` is a library language of this user, which is what makes it an
  // offerable translation target below — the controller refuses a target it
  // never offered, so a track+library pair that can't reach `ru` would make
  // these cases assert against an unreachable call.
  useLibraryLanguages: () => ref(["en", "ru"]),
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
    availableLanguages: ref(["en"]),
    activeLanguages: ref(["en"]),
    hydrate: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  }),
}))
vi.mock("../transcript/useTranscriptLoader.js", () => ({
  useTranscriptLoader: () => ({
    errorKey: loaderError,
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

/**
 * A failed ACTION must not take the transcript off the screen.
 *
 * These cases used to assert the opposite — that a failed chapter tap landed in
 * `loader.error` — and called that "the banner". There is no banner:
 * `TranscriptDialog` renders `<TranscriptText v-if="statusState === null">`, so
 * a non-null `loader.error` REPLACES the whole reader with an error state, and
 * `reload()` never cleared it. The user lost the text they were reading and
 * only closing and re-opening the dialog brought it back (issue #1583). The
 * assertions below are inverted on purpose: `loader.error` stays the load
 * channel, and the failure is reported through the toast.
 */
describe("useTranscriptDialogController.onChapterSeek — preview mode", () => {
  beforeEach(() => {
    loaderError.value = null
    openTrack.mockReset()
    toastError.mockReset()
  })

  it("reports a refused openTrack with a translated message, not a raw error code", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "engine-failed" })

    await useTranscriptDialogController().onChapterSeek(12000)

    // The regression this guards: the site used to render the hardcoded
    // English `Could not start playback: engine-failed`.
    expect(toastError).toHaveBeenCalledWith("translated:errors.playbackFailed")
  })

  it("uses the permanent message for a transcript-only lecture", async () => {
    // Chapter rows render off the outline with no audio gate, so this is
    // reachable — and retrying can never make audio appear.
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })

    await useTranscriptDialogController().onChapterSeek(12000)

    expect(toastError).toHaveBeenCalledWith("translated:errors.noAudioForLecture")
  })

  it("leaves the transcript on screen when the chapter tap fails", async () => {
    openTrack.mockResolvedValue({ ok: false, error: "no-audio-available" })

    await useTranscriptDialogController().onChapterSeek(12000)

    // `loader.error` is what swaps the reader for an error state — an action
    // failure must never write to it.
    expect(loaderError.value).toBeNull()
  })

  it("says nothing when playback starts", async () => {
    openTrack.mockResolvedValue({ ok: true, value: undefined })

    await useTranscriptDialogController().onChapterSeek(12000)

    expect(openTrack).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
    expect(loaderError.value).toBeNull()
  })
})

/**
 * A translate run that never produces a variant used to end in silence: the
 * ghost chip spun for up to six minutes and then simply stopped, with no way to
 * tell a failure from a run still going (issue #1589).
 */
describe("useTranscriptDialogController.onTranslateLanguage", () => {
  beforeEach(() => {
    loaderError.value = null
    toastError.mockReset()
    toastInfo.mockReset()
    submit.mockReset()
    status.mockReset()
    submit.mockResolvedValue({ run_id: "run-1" })
  })

  it("reports a failed run", async () => {
    status.mockResolvedValue({ state: "failed" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("ru")
      await vi.advanceTimersByTimeAsync(3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastError).toHaveBeenCalledWith("translated:errors.translationFailed")
    expect(loaderError.value).toBeNull()
  })

  it("reports a cancelled run as cancelled, not as a failure", async () => {
    // This case used to assert the opposite — that a cancelled run is reported
    // "the same way" a failed one is. It is not the same thing to the user:
    // nothing broke, and "try again later" invites a second run on something
    // that was stopped on purpose.
    status.mockResolvedValue({ state: "cancelled" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("ru")
      await vi.advanceTimersByTimeAsync(3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastInfo).toHaveBeenCalledWith("translated:errors.translationCancelled")
    expect(toastError).not.toHaveBeenCalled()
    expect(loaderError.value).toBeNull()
  })

  it("tells the user a run that outlives the poll is still going, not failed", async () => {
    // Never leaves `running`: the poll gives up, the RUN does not.
    status.mockResolvedValue({ state: "running" })
    vi.useFakeTimers()
    try {
      const done = useTranscriptDialogController().onTranslateLanguage("ru")
      // 120 polls, 3s apart.
      await vi.advanceTimersByTimeAsync(120 * 3000)
      await done
    } finally {
      vi.useRealTimers()
    }

    expect(toastInfo).toHaveBeenCalledWith("translated:errors.translationStillRunning")
    expect(toastError).not.toHaveBeenCalled()
  })
})
