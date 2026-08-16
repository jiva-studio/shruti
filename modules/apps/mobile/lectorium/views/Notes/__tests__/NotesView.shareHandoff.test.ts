import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { Track } from "@lib/domain/track.js"

/**
 * #1903 — the note audio share races the work against a 3-second timer before
 * handing it to the background. `finally` returns a derived promise that
 * re-raises the rejection, and nothing consumed that one: a share failing
 * after the handoff reported an unhandled rejection (console noise, and a
 * Sentry event on some runtimes) on a path that fires whenever the cut is
 * slow.
 */

const TRACK = "t1" as TrackId
const NOTE = "n1" as NoteId

const track = {
  id: TRACK,
  authorId: null,
  locationId: null,
  date: "1996-03-14",
  references: [],
  variants: [{ language: "ru", title: "Лекция", audio: { path: "a.mp3" } }],
} as unknown as Track

const note: Note = {
  id: NOTE,
  trackId: TRACK,
  text: "a thought worth keeping",
  timeStart: 0,
  timeEnd: 1000,
  createdAt: 1000,
  meta: null,
}

interface SheetButton {
  text: string
  handler?: () => void
}

/** Buttons of the last action sheet the controller opened imperatively. */
let sheetButtons: SheetButton[] = []
const modal = { message: "", present: vi.fn(async () => {}), dismiss: vi.fn(async () => {}) }

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: {
    create: vi.fn(async (opts: { buttons: SheetButton[] }) => {
      sheetButtons = opts.buttons
      return { present: vi.fn(async () => {}) }
    }),
  },
  loadingController: { create: vi.fn(async () => modal) },
  onIonViewWillEnter: vi.fn(),
}))
vi.mock("@lectorium/router/index.js", () => ({ default: { push: vi.fn() } }))

const toastError = vi.fn(async () => {})
const toastInfo = vi.fn(async () => {})
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: toastError, info: toastInfo, success: vi.fn(), show: vi.fn() }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("ru") }))

const getByIds = vi.fn(async () => new Map<TrackId, Track>([[TRACK, track]]))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({ tracks: { getByIds } }),
    shareService: { share: vi.fn(async () => {}), copyToClipboard: vi.fn() },
    shareAudioService: { cut: vi.fn() },
    activeServer: ref({ id: "eu", urlTemplate: "https://cdn.example.com/{path}" }),
    haptics: { impact: vi.fn() },
    excerptCache: { download: vi.fn(), findLocal: vi.fn(), probeRemote: vi.fn() },
  }),
}))
vi.mock("@lectorium/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    authorsById: new Map(),
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@lectorium/stores/useNotesStore.js", () => ({ useNotesStore: () => store }))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen: vi.fn() }),
}))
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true }),
}))
const markInBackground = vi.fn()
const finish = vi.fn()
vi.mock("@lectorium/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({ tryStart: vi.fn(() => true), markInBackground, finish }),
}))
vi.mock("@lectorium/stores/useStudioHandoffStore.js", () => ({
  useStudioHandoffStore: () => ({ setPending: vi.fn() }),
}))

/** The share work itself — a promise this test settles by hand. */
const resolveShareArtifact = vi.fn()
vi.mock("@lectorium/services/resolveShareArtifact.js", () => ({
  resolveShareArtifact: () => resolveShareArtifact(),
}))

const store = reactive({
  all: [] as readonly Note[],
  filtered: [] as readonly Note[],
  rendered: [] as readonly Note[],
  query: "",
  appliedQuery: "",
  isLoading: false,
  error: null as string | null,
  hasMore: false,
  refresh: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn(),
  setQuery: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
})

import { useNotesController } from "../NotesView.controller.js"

const HANDOFF_MS = 3_000

/** The runner's process, typed locally — the app builds without `@types/node`. */
type RejectionListener = (reason: unknown) => void
const runner = (
  globalThis as unknown as {
    process: {
      on: (event: "unhandledRejection", listener: RejectionListener) => void
      off: (event: "unhandledRejection", listener: RejectionListener) => void
    }
  }
).process

/** Let queued microtasks and the controller's awaits settle. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

describe("notes share handoff", () => {
  beforeEach(() => {
    sheetButtons = []
    toastError.mockClear()
    toastInfo.mockClear()
    resolveShareArtifact.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("handles a rejection that lands after the work was handed to the background", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    runner.on("unhandledRejection", onUnhandled)

    try {
      let fail!: (err: unknown) => void
      resolveShareArtifact.mockReturnValue(
        new Promise<string>((_, reject) => {
          fail = reject
        })
      )

      vi.useFakeTimers()
      const { onNoteClicked, actionSheetButtons } = useNotesController()
      // Pushed AFTER creation so the controller's `rendered` watcher runs the
      // track join — the share needs the note's lecture resolved.
      store.all = [note]
      store.filtered = [note]
      store.rendered = [note]
      await flush()

      await onNoteClicked(NOTE)
      actionSheetButtons.value.find((b) => b.text === "app.share")!.handler!()
      await flush()

      sheetButtons.find((b) => b.text === "notes.shareAudio")!.handler!()
      await flush()

      // Nobody has settled the work yet: the 3 s handoff fires, the modal goes
      // away and the job continues in the background.
      await vi.advanceTimersByTimeAsync(HANDOFF_MS)
      expect(markInBackground).toHaveBeenCalled()

      fail(new Error("cut service is down"))
      vi.useRealTimers()
      await flush()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))

      // The background branch reports it; nothing else may re-raise it.
      expect(toastError).toHaveBeenCalledWith("notes.shareAudioErrorGeneric")
      expect(unhandled).toEqual([])
    } finally {
      runner.off("unhandledRejection", onUnhandled)
    }
  })
})
