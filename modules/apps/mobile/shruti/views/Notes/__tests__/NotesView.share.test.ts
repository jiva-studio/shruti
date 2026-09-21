import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive, ref } from "vue"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackAudio, TrackVariant } from "@lib/domain/trackVariant.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const TRACK = "t1" as TrackId
const NOTE = "n1" as NoteId

interface SheetButton {
  readonly text: string
  readonly cssClass?: string
  readonly role?: string
  readonly handler?: () => void
}

/** Buttons of the nested share sheet the note opened. */
let sheetButtons: SheetButton[] = []
let sheetHeader = ""

const shared: { text?: string; url?: string; title?: string; dialogTitle?: string }[] = []
const copied: string[] = []
const toastErrors: string[] = []
const toastInfos: string[] = []
const routed: string[] = []
const handoffs: { kind: string; noteId: string }[] = []

let proGranted = true
const proGates: string[] = []
let artifactUri = "file:///excerpts/n1.mp3"
let artifactFails = false
const cuts: { sourceKey: string; startMs: number; endMs: number; excerptId: string }[] = []
const artifactRequests: { filename: string; predictedUrl: string }[] = []
let cutSpec: { url: string; ready: boolean } = { url: "", ready: true }

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: {
    create: async (opts: { header: string; buttons: SheetButton[] }) => {
      sheetHeader = opts.header
      sheetButtons = opts.buttons
      return { present: async () => undefined }
    },
  },
  loadingController: {
    create: async () => ({ present: async () => undefined, dismiss: async () => undefined }),
  },
  onIonViewWillEnter: vi.fn(),
}))
vi.mock("@shruti/router/index.js", () => ({
  default: {
    push: async (path: string) => void routed.push(path),
  },
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({
    error: async (text: string) => void toastErrors.push(text),
    info: async (text: string) => void toastInfos.push(text),
    success: vi.fn(),
    show: vi.fn(),
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))

const getByIds = vi.fn(async () => new Map<TrackId, Track>([[TRACK, track]]))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ tracks: { getByIds } }),
    shareService: {
      share: async (payload: Record<string, string>) => void shared.push(payload),
      copyToClipboard: async (text: string) => void copied.push(text),
    },
    shareAudioService: {
      cut: async (req: (typeof cuts)[number]) => {
        cuts.push(req)
        return cutSpec
      },
    },
    activeServer: ref({ id: "eu", name: "Europe", urlTemplate: "https://cdn.example/{path}" }),
    haptics: { impact: vi.fn() },
    excerptCache: { download: vi.fn(), findLocal: vi.fn(), probeRemote: vi.fn() },
  }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    authorsById: new Map(),
    locationsById: new Map(),
    sourcesById: new Map(),
  }),
}))
vi.mock("@shruti/stores/useNotesStore.js", () => ({ useNotesStore: () => store }))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    isSubscribed: proGranted,
    ensurePro: async (reason: string) => {
      proGates.push(reason)
      return proGranted
    },
  }),
}))
vi.mock("@shruti/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({
    tryStart: () => true,
    markInBackground: vi.fn(),
    finish: vi.fn(),
  }),
}))
vi.mock("@shruti/stores/useStudioHandoffStore.js", () => ({
  useStudioHandoffStore: () => ({
    setPending: (h: { kind: string; noteId: string }) => void handoffs.push(h),
  }),
}))
interface ArtifactArgs {
  readonly filename: string
  readonly predictedUrl: string
  readonly cut: () => Promise<{ url: string; ready: boolean }>
}

vi.mock("@shruti/services/resolveShareArtifact.js", () => ({
  resolveShareArtifact: async (args: ArtifactArgs) => {
    artifactRequests.push({ filename: args.filename, predictedUrl: args.predictedUrl })
    if (artifactFails) throw new Error("the cutter is down")
    await args.cut()
    return artifactUri
  },
}))

/* --------------------------------------------------------------------- */
/*                               Fixtures                                */
/* --------------------------------------------------------------------- */

function variant(audioPath: string | undefined): TrackVariant {
  const audio: TrackAudio | null =
    audioPath === undefined
      ? null
      : { path: audioPath, filesize: null, duration: 120_000, kind: "original" }
  return {
    trackId: TRACK,
    language: "ru",
    title: "Вечерняя лекция",
    audios: audio ? [audio] : [],
    audio,
    transcript: null,
    outline: null,
    description: null,
  }
}

function lecture(audioPath?: string): Track {
  return {
    id: TRACK,
    authorId: null,
    locationId: null,
    date: "1996-03-14",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant(audioPath)],
  }
}

let track: Track = lecture("library/t1.mp3")

const note: Note = {
  id: NOTE,
  trackId: TRACK,
  text: "a thought worth keeping",
  timeStart: 60_000,
  timeEnd: 90_000,
  createdAt: 1000,
  meta: null,
}

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
  refresh: vi.fn().mockResolvedValue(undefined),
  loadMore: vi.fn(),
  setQuery: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
})

const { useNotesController } = await import("../NotesView.controller.js")

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

/** Open the note's sheet and hand back the nested share sheet's buttons. */
async function openShareMenu(): Promise<SheetButton[]> {
  const { onNoteClicked, actionSheetButtons } = useNotesController()
  store.all = [note]
  store.filtered = [note]
  store.rendered = [note]
  await flush()
  await onNoteClicked(NOTE)
  actionSheetButtons.value.find((b) => b.text === "app.share")!.handler!()
  await flush()
  return sheetButtons
}

const pressShare = async (text: string): Promise<void> => {
  const buttons = await openShareMenu()
  buttons.find((b) => b.text === text)!.handler!()
  await flush()
}

describe("sharing a note", () => {
  beforeEach(() => {
    sheetButtons = []
    sheetHeader = ""
    shared.length = 0
    copied.length = 0
    toastErrors.length = 0
    toastInfos.length = 0
    routed.length = 0
    handoffs.length = 0
    cuts.length = 0
    artifactRequests.length = 0
    proGates.length = 0
    proGranted = true
    artifactFails = false
    artifactUri = "file:///excerpts/n1.mp3"
    cutSpec = { url: "", ready: true }
    track = lecture("library/t1.mp3")
  })

  it("offers text, audio and video under one header", async () => {
    const buttons = await openShareMenu()
    expect(sheetHeader).toBe("notes.share")
    expect(buttons.map((b) => b.text)).toEqual([
      "notes.shareText",
      "notes.shareAudio",
      "notes.shareVideo",
      "app.close",
    ])
  })

  it("copies the note with its lecture's bibliographic line", async () => {
    const { onNoteClicked, actionSheetButtons } = useNotesController()
    store.all = [note]
    store.filtered = [note]
    store.rendered = [note]
    await flush()
    await onNoteClicked(NOTE)

    actionSheetButtons.value.find((b) => b.text === "notes.copyText")!.handler!()
    await flush()

    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain("a thought worth keeping")
    expect(copied[0]).toContain("Вечерняя лекция")
  })

  it("shares the same text through the system sheet", async () => {
    await pressShare("notes.shareText")
    expect(shared).toHaveLength(1)
    expect(shared[0]!.text).toContain("a thought worth keeping")
  })

  it("hands the cut excerpt to the system sheet, titled with the lecture", async () => {
    await pressShare("notes.shareAudio")

    expect(cuts).toEqual([
      { sourceKey: "library/t1.mp3", startMs: 60_000, endMs: 90_000, excerptId: NOTE },
    ])
    expect(artifactRequests).toEqual([
      {
        filename: "share-audio-note-n1.mp3",
        predictedUrl: "https://cdn.example/public/shares/audio/n1.mp3",
      },
    ])
    expect(shared).toEqual([
      {
        url: "file:///excerpts/n1.mp3",
        title: "Вечерняя лекция",
        dialogTitle: "notes.shareAudioDialog",
      },
    ])
  })

  it("says so instead of sharing when the cut fails", async () => {
    artifactFails = true
    await pressShare("notes.shareAudio")

    expect(shared).toEqual([])
    expect(toastErrors).toEqual(["notes.shareAudioErrorGeneric"])
  })

  it("refuses an audio share for a lecture with no audio", async () => {
    track = lecture()

    await pressShare("notes.shareAudio")

    expect(cuts).toEqual([])
    expect(toastErrors).toEqual(["notes.shareAudioErrorNoAudio"])
  })
})

describe("opening a note in Studio", () => {
  beforeEach(() => {
    routed.length = 0
    handoffs.length = 0
    proGates.length = 0
    proGranted = true
  })

  it("hands the note over and navigates to the editor", async () => {
    await pressShare("notes.shareVideo")

    expect(proGates).toEqual(["notesStudio"])
    expect(handoffs).toEqual([{ kind: "note", noteId: NOTE }])
    expect(routed).toEqual(["/tabs/studio"])
  })

  it("goes nowhere when the Pro gate turns the user away", async () => {
    proGranted = false
    await pressShare("notes.shareVideo")

    expect(handoffs).toEqual([])
    expect(routed).toEqual([])
  })

  it("marks the video entry as the Pro one", async () => {
    const buttons = await openShareMenu()
    expect(buttons.find((b) => b.text === "notes.shareVideo")?.cssClass).toBe("action-sheet-pro")
  })
})
