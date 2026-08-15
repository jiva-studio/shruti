import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { Track } from "@lib/domain/track.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const getByIds = vi.fn<(ids: readonly TrackId[]) => Promise<ReadonlyMap<TrackId, Track>>>()
const appLanguage = ref("ru")

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: { create: vi.fn() },
  loadingController: { create: vi.fn() },
  onIonViewWillEnter: vi.fn(),
}))
vi.mock("@lectorium/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), show: vi.fn() }),
}))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => appLanguage,
}))
vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({ tracks: { getByIds } }),
    shareService: { share: vi.fn(), copyToClipboard: vi.fn() },
    shareAudioService: { cut: vi.fn() },
    activeServer: ref(null),
    haptics: { impact: vi.fn() },
    excerptCache: { download: vi.fn() },
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
vi.mock("@lectorium/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({ tryStart: vi.fn(() => true), finish: vi.fn() }),
}))
vi.mock("@lectorium/stores/useStudioHandoffStore.js", () => ({
  useStudioHandoffStore: () => ({ setPending: vi.fn() }),
}))

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

const LIVE = "t-live" as TrackId
const GONE = "t-gone" as TrackId

function note(id: string, trackId: TrackId): Note {
  return {
    id: id as NoteId,
    trackId,
    text: "a thought worth keeping",
    timeStart: 0,
    timeEnd: 1000,
    createdAt: 1000,
    meta: null,
  }
}

const liveTrack = {
  id: LIVE,
  authorId: null,
  locationId: null,
  date: "1996-03-14",
  references: [],
  variants: [{ language: "ru", title: "Лекция", audio: { path: "a.mp3" } }],
} as unknown as Track

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

/** Push notes into the store and let the controller's track join settle. */
async function render(notes: readonly Note[]): Promise<void> {
  store.all = notes
  store.filtered = notes
  store.rendered = notes
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe("useNotesController rows", () => {
  beforeEach(() => {
    appLanguage.value = "ru"
    store.all = []
    store.filtered = []
    store.rendered = []
    getByIds.mockReset()
    getByIds.mockImplementation(async (ids) => {
      const found = new Map<TrackId, Track>()
      if (ids.includes(LIVE)) found.set(LIVE, liveTrack)
      return found
    })
  })

  it("marks a row whose lecture left the catalog, without hiding the note", async () => {
    const { rows } = useNotesController()
    await render([note("n1", GONE), note("n2", LIVE)])

    const gone = rows.value.find((r) => r.id === "n1")!
    // The user's own text is the durable artifact — it stays on screen.
    expect(gone.text).toContain("a thought worth keeping")
    // Everything the lecture would have supplied is missing, which is why the
    // play button rendered enabled and did nothing.
    expect(gone.trackUnresolved).toBe(true)
    expect(gone.audioPath).toBeUndefined()
    expect(gone.trackTitle).toBeUndefined()

    expect(rows.value.find((r) => r.id === "n2")!.trackUnresolved).toBe(false)
  })

  it("stays optimistic until the tracks have actually been read", async () => {
    const { rows } = useNotesController()
    store.rendered = [note("n1", LIVE)]

    // First paint: the content-DB read hasn't resolved yet. Flagging the row
    // here would flash a degraded card on every entry to the tab.
    expect(rows.value[0]!.trackUnresolved).toBe(false)
  })

  it("does not flag rows when the content-DB read fails", async () => {
    getByIds.mockRejectedValue(new Error("database is locked"))

    const { rows } = useNotesController()
    await render([note("n1", LIVE)])

    // A failed read says nothing about whether the lecture exists.
    expect(rows.value[0]!.trackUnresolved).toBe(false)
  })

  it("localizes the lecture date instead of printing the raw ISO value", async () => {
    const { rows } = useNotesController()
    await render([note("n1", LIVE)])
    expect(rows.value[0]!.trackDate).toBe("14.03.1996")

    appLanguage.value = "en"
    expect(rows.value[0]!.trackDate).toBe("14 Mar 1996")
  })
})
