import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { Track } from "@lib/domain/track.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const TRACK = "t1" as TrackId

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: { create: async () => ({ present: async () => undefined }) },
  loadingController: {
    create: async () => ({ present: async () => undefined, dismiss: async () => undefined }),
  },
  onIonViewWillEnter: vi.fn(),
}))
vi.mock("@shruti/router/index.js", () => ({ default: { push: vi.fn() } }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), show: vi.fn() }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ tracks: { getByIds: async () => new Map<TrackId, Track>() } }),
    shareService: { share: vi.fn(), copyToClipboard: vi.fn() },
    shareAudioService: { cut: vi.fn() },
    activeServer: ref(null),
    haptics: { impact: async () => void haptics.push("light") },
    excerptCache: { download: vi.fn() },
  }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => undefined,
    authorsById: new Map(),
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({ useNotesStore: () => store }))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true, ensurePro: async () => true }),
}))
vi.mock("@shruti/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({ tryStart: () => true, markInBackground: vi.fn(), finish: vi.fn() }),
}))
vi.mock("@shruti/stores/useStudioHandoffStore.js", () => ({
  useStudioHandoffStore: () => ({ setPending: vi.fn() }),
}))

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

const haptics: string[] = []

function note(id: string, text = "a thought worth keeping"): Note {
  return {
    id: id as NoteId,
    trackId: TRACK,
    text,
    timeStart: 0,
    timeEnd: 1000,
    createdAt: 1000,
    meta: null,
  }
}

/** A notes store with the behaviour the page depends on: a query that filters,
 *  paging that widens the window, and a removal that takes the note away. */
const store = reactive({
  all: [] as readonly Note[],
  filtered: [] as readonly Note[],
  rendered: [] as readonly Note[],
  query: "",
  appliedQuery: "",
  isLoading: false,
  error: null as string | null,
  hasMore: false,
  searchTruncated: false,
  searchLimit: 200,
  pageSize: 1,
  refresh: async () => undefined,
  loadMore(): void {
    this.pageSize += 1
    this.reproject()
  },
  async setQuery(next: string): Promise<void> {
    this.query = next
    this.appliedQuery = next
    this.reproject()
  },
  async remove(id: NoteId): Promise<void> {
    this.all = this.all.filter((n) => n.id !== id)
    this.reproject()
  },
  reproject(): void {
    const q = this.appliedQuery.trim().toLowerCase()
    this.filtered = q ? this.all.filter((n) => n.text.toLowerCase().includes(q)) : this.all
    this.rendered = this.filtered.slice(0, this.pageSize)
    this.hasMore = this.filtered.length > this.rendered.length
  },
})

const { useNotesController } = await import("../NotesView.controller.js")

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

function seed(notes: readonly Note[]): void {
  store.all = notes
  store.pageSize = 10
  store.query = ""
  store.appliedQuery = ""
  store.isLoading = false
  store.error = null
  store.reproject()
}

describe("what the page shows instead of a list", () => {
  beforeEach(() => {
    seed([])
  })

  it("explains a failed read rather than claiming the user has no notes", () => {
    store.error = "database is locked"
    const { sticker, hasError, isEmpty } = useNotesController()

    expect(hasError.value).toBe(true)
    expect(isEmpty.value).toBe(false)
    expect(sticker.value?.header).toBe("notes.loadFailedTitle")
  })

  it("invites the user to the catalog when there are no notes at all", () => {
    const { sticker, isEmpty } = useNotesController()

    expect(isEmpty.value).toBe(true)
    expect(sticker.value).toMatchObject({ header: "notes.notesAreEmpty", to: "search" })
  })

  it("says nothing while the first read is still running", () => {
    store.isLoading = true
    const { sticker, isEmpty } = useNotesController()

    expect(isEmpty.value).toBe(false)
    expect(sticker.value).toBeNull()
  })

  it("reports an unmatched search without offering the empty-state invitation", async () => {
    seed([note("n1")])
    const { sticker, onQuery } = useNotesController()

    await onQuery("gardening")
    await flush()

    expect(sticker.value?.header).toBe("notes.notFoundTitle")
    expect(sticker.value?.to).toBeUndefined()
  })

  it("steps aside once the list has something to show", () => {
    seed([note("n1")])
    const { sticker } = useNotesController()
    expect(sticker.value).toBeNull()
  })
})

describe("searching and paging", () => {
  it("narrows the rows to the matches and reports the live query", async () => {
    seed([note("n1", "about bhakti"), note("n2", "about cooking")])
    const { rows, query, onQuery } = useNotesController()

    await onQuery("bhakti")
    await flush()

    expect(query.value).toBe("bhakti")
    expect(rows.value.map((r) => r.id)).toEqual(["n1"])
  })

  it("highlights the match inside the note's text", async () => {
    seed([note("n1", "about bhakti")])
    const { rows, onQuery } = useNotesController()

    await onQuery("bhakti")
    await flush()

    expect(rows.value[0]!.text).toContain("<mark")
  })

  it("pages in more notes while more of them match", async () => {
    seed([note("n1"), note("n2"), note("n3")])
    store.pageSize = 1
    store.reproject()
    const { rows, hasMore, loadMore } = useNotesController()

    expect(rows.value).toHaveLength(1)
    expect(hasMore.value).toBe(true)

    loadMore()
    await flush()
    loadMore()
    await flush()

    expect(rows.value.map((r) => r.id)).toEqual(["n1", "n2", "n3"])
    expect(hasMore.value).toBe(false)
  })
})

describe("the note's own action sheet", () => {
  beforeEach(() => {
    haptics.length = 0
    seed([note("n1"), note("n2")])
  })

  it("opens on a tap, with a haptic tick", async () => {
    const { isActionSheetOpen, actionSheetButtons, onNoteClicked } = useNotesController()

    expect(isActionSheetOpen.value).toBe(false)
    await onNoteClicked("n1")

    expect(isActionSheetOpen.value).toBe(true)
    expect(haptics).toEqual(["light"])
    expect(actionSheetButtons.value.map((b) => b.text)).toEqual([
      "notes.copyText",
      "app.share",
      "app.delete",
      "app.cancel",
    ])
  })

  it("deletes the note the user tapped, and only that one", async () => {
    const { rows, actionSheetButtons, onNoteClicked } = useNotesController()

    await onNoteClicked("n2")
    actionSheetButtons.value.find((b) => b.text === "app.delete")!.handler!()
    await flush()

    expect(rows.value.map((r) => r.id)).toEqual(["n1"])
  })

  it("deletes nothing when no note was selected", async () => {
    const { rows, actionSheetButtons } = useNotesController()

    actionSheetButtons.value.find((b) => b.text === "app.delete")!.handler!()
    await flush()

    expect(rows.value.map((r) => r.id)).toEqual(["n1", "n2"])
  })

  it("marks the destructive entry as such", () => {
    const { actionSheetButtons } = useNotesController()
    const roles = actionSheetButtons.value.map((b) => b.role)
    expect(roles).toEqual([undefined, undefined, "destructive", "cancel"])
  })
})
