import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import type { Transcript } from "@lib/domain/transcript.js"
import type { ShareOptions } from "@ports/app/index.js"

const TRACK = "track_1" as TrackId

interface SheetButton {
  id?: string
  text: string
  disabled?: boolean
  cssClass?: string
  handler?: () => void
}
let sheetButtons: SheetButton[] = []

const state = vi.hoisted(() => ({
  appLanguage: "en",
  libraryLanguages: ["en"] as string[],
  availableLanguages: [] as string[],
  availableLanguagesThrows: false,
  track: null as unknown,
  trackThrows: false,
  transcript: null as unknown,
  transcriptPath: null as string | null,
  subscribed: true,
  resolved: true,
  proGranted: true,
}))

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: {
    create: vi.fn(async (opts: { buttons: SheetButton[] }) => {
      sheetButtons = opts.buttons
      return { present: vi.fn(async () => {}), onDidDismiss: vi.fn(async () => {}) }
    }),
  },
  loadingController: {
    create: vi.fn(async () => ({
      message: "",
      present: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    })),
  },
}))

const share = vi.fn<(options: ShareOptions) => Promise<void>>(async () => {})
const prepareLocalPdf = vi.fn(async () => "file:///local/track_1.pdf")
const trackSheetClose = vi.fn()
const ensurePro = vi.fn(async () => state.proGranted)

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      tracks: {
        getById: vi.fn(async () => {
          if (state.trackThrows) throw new Error("db closed")
          return state.track
        }),
        getTranscriptPath: vi.fn(async () => state.transcriptPath),
      },
      transcripts: {
        availableLanguages: vi.fn(async () => {
          if (state.availableLanguagesThrows) throw new Error("db closed")
          return state.availableLanguages
        }),
        get: vi.fn(async () => state.transcript),
      },
    }),
    shareService: { share },
    haptics: { impact: vi.fn() },
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ref(state.appLanguage),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(state.libraryLanguages),
}))
vi.mock("@shruti/composables/useShareTranscript.js", () => ({
  useShareTranscript: () => ({ prepareLocalPdf }),
}))
vi.mock("@shruti/composables/useShareAudioArtifact.js", () => ({
  useShareAudioArtifact: () => vi.fn(async () => ({ ok: false, reason: "no_audio" })),
}))
vi.mock("@shruti/composables/shareCover.js", () => ({
  buildShareCover: (track: Track | null) => ({
    title: track ? "A lecture" : null,
    author: null,
    date: null,
  }),
}))
vi.mock("@shruti/stores/useOverlaysStore.js", () => ({
  useOverlaysStore: () => ({ actionSheetOpen: false }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({ sourcesById: new Map(), tagsById: new Map() }),
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    get resolved() {
      return state.resolved
    },
    get isSubscribed() {
      return state.subscribed
    },
    ensurePro,
  }),
}))
vi.mock("@shruti/stores/useTrackSheetStore.js", () => ({
  useTrackSheetStore: () => ({ close: trackSheetClose }),
}))

const toastError = vi.fn(async () => {})
vi.mock("@kit/composables", () => ({
  useToast: () => ({ info: vi.fn(), error: toastError, success: vi.fn(), show: vi.fn() }),
}))

const tryStart = vi.fn(() => true)
vi.mock("@shruti/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({ tryStart, markInBackground: vi.fn(), finish: vi.fn() }),
}))

import { useShareTrack } from "../useShareTrack.js"

function track(over: Partial<Track> = {}): Track {
  return {
    id: TRACK,
    authorId: null,
    locationId: null,
    date: "2020-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [variant("en", "A lecture")],
    ...over,
  } as unknown as Track
}

function variant(language: string, title: string): TrackVariant {
  return { trackId: TRACK, language: language as LanguageCode, title, audio: null } as TrackVariant
}

function transcript(...lines: string[]): Transcript {
  return {
    blocks: lines.map((text) => ({ type: "sentence", text })),
  } as unknown as Transcript
}

async function tap(id: string): Promise<void> {
  const { presentShareMenu } = useShareTrack()
  await presentShareMenu(TRACK)
  const button = sheetButtons.find((b) => b.id === id)
  expect(button).toBeDefined()
  button!.handler!()
  await flush()
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(3_000)
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe("useShareTrack — the menu", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    state.appLanguage = "en"
    state.libraryLanguages = ["en"]
    state.availableLanguages = ["en"]
    state.availableLanguagesThrows = false
    state.trackThrows = false
    state.track = track()
    state.transcript = transcript("Line one.")
    state.transcriptPath = "transcripts/track_1/en.json"
    state.subscribed = true
    state.resolved = true
    state.proGranted = true
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("greys out the transcript formats for a lecture with no transcript", async () => {
    state.availableLanguages = []
    await useShareTrack().presentShareMenu(TRACK)

    expect(sheetButtons.find((b) => b.id === "share-pdf")!.disabled).toBe(true)
    expect(sheetButtons.find((b) => b.id === "share-text")!.disabled).toBe(true)
    // The link is never gated on content being present.
    expect(sheetButtons.find((b) => b.id === "share-link")!.disabled).toBeUndefined()
  })

  it("greys out audio for a translation-only lecture", async () => {
    await useShareTrack().presentShareMenu(TRACK)
    expect(sheetButtons.find((b) => b.id === "share-audio")!.disabled).toBe(true)

    state.track = track({
      variants: [
        {
          ...variant("en", "A lecture"),
          audio: { path: "a.mp3", filesize: 1, duration: 1, kind: "original" },
        } as TrackVariant,
      ],
    })
    await useShareTrack().presentShareMenu(TRACK)
    expect(sheetButtons.find((b) => b.id === "share-audio")!.disabled).toBe(false)
  })

  it("offers every format when the lookups fail rather than greying them all out", async () => {
    state.availableLanguagesThrows = true
    state.trackThrows = true
    await useShareTrack().presentShareMenu(TRACK)

    expect(sheetButtons.find((b) => b.id === "share-pdf")!.disabled).toBe(false)
    expect(sheetButtons.find((b) => b.id === "share-text")!.disabled).toBe(false)
    expect(sheetButtons.find((b) => b.id === "share-audio")!.disabled).toBe(false)
  })

  it("badges PDF as Pro only once the store answered that the user is not", async () => {
    state.subscribed = true
    await useShareTrack().presentShareMenu(TRACK)
    expect(sheetButtons.find((b) => b.id === "share-pdf")!.cssClass).toBeUndefined()

    state.resolved = false
    state.subscribed = false
    await useShareTrack().presentShareMenu(TRACK)
    expect(sheetButtons.find((b) => b.id === "share-pdf")!.cssClass).toBeUndefined()

    state.resolved = true
    await useShareTrack().presentShareMenu(TRACK)
    expect(sheetButtons.find((b) => b.id === "share-pdf")!.cssClass).toBe("action-sheet-pro")
  })
})

describe("useShareTrack — the web link", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    state.appLanguage = "en"
    state.libraryLanguages = ["en"]
    state.availableLanguages = ["en"]
    state.availableLanguagesThrows = false
    state.trackThrows = false
    state.track = track()
    state.subscribed = true
    state.resolved = true
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("shares the lecture page in the interface language, titled in its own", async () => {
    state.appLanguage = "en"
    state.libraryLanguages = ["ru"]
    state.track = track({ variants: [variant("en", "A lecture"), variant("ru", "Лекция")] })

    await tap("share-link")

    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://shruti.app/en/app/1",
        title: "Лекция",
      })
    )
  })

  it("falls back to the default web locale for a language the site does not serve", async () => {
    state.appLanguage = "kk"
    await tap("share-link")
    expect(share.mock.calls[0][0].url).toBe("https://shruti.app/en/app/1")
  })

  it("lowercases a script-tagged locale into its web path", async () => {
    state.appLanguage = "sr-Latn"
    await tap("share-link")
    expect(share.mock.calls[0][0].url).toBe("https://shruti.app/sr-latn/app/1")
  })

  it("still shares a link for a lecture missing from the catalog, titled by id", async () => {
    state.track = null
    await tap("share-link")
    expect(share.mock.calls[0][0]).toMatchObject({
      url: "https://shruti.app/en/app/1",
      title: TRACK,
    })
  })

  it("says the share failed instead of sharing nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    state.trackThrows = true
    await tap("share-link")

    expect(share).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("search.share.error")
  })
})

describe("useShareTrack — the transcript as text", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    state.appLanguage = "en"
    state.libraryLanguages = ["en"]
    state.availableLanguages = ["en"]
    state.availableLanguagesThrows = false
    state.trackThrows = false
    state.track = track()
    state.transcript = transcript("Line one.", "Line two.")
    state.subscribed = true
    state.resolved = true
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("heads the text with the lecture title and date", async () => {
    await tap("share-text")
    expect(share.mock.calls[0][0]).toMatchObject({
      text: "A lecture (2020-01-01)\n\nLine one.\nLine two.",
      title: "A lecture",
    })
  })

  it("leaves the date out for a lecture that has none", async () => {
    state.track = track({ date: "" } as Partial<Track>)
    await tap("share-text")
    expect(share.mock.calls[0][0].text).toBe("A lecture\n\nLine one.\nLine two.")
  })

  it("shares a library language over the interface one", async () => {
    state.appLanguage = "en"
    state.libraryLanguages = ["ru"]
    state.availableLanguages = ["en", "ru"]
    state.track = track({ variants: [variant("en", "A lecture"), variant("ru", "Лекция")] })

    await tap("share-text")
    expect(share.mock.calls[0][0].title).toBe("Лекция")
  })

  it("breaks a tie between library languages by the interface language", async () => {
    state.appLanguage = "en"
    state.libraryLanguages = ["ru", "en"]
    state.availableLanguages = ["ru", "en"]
    state.track = track({ variants: [variant("en", "A lecture"), variant("ru", "Лекция")] })

    await tap("share-text")
    expect(share.mock.calls[0][0].title).toBe("A lecture")
  })

  it("shares the one language a lecture has even when it is not a library one", async () => {
    state.appLanguage = "en"
    state.libraryLanguages = ["ru"]
    state.availableLanguages = ["en"]

    await tap("share-text")
    expect(share.mock.calls[0][0].title).toBe("A lecture")
  })

  it("says there is no transcript rather than sharing an empty file", async () => {
    state.availableLanguages = []
    await tap("share-text")
    expect(share).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("search.share.noTranscript")
  })

  it("says there is no transcript when the stored one holds no readable text", async () => {
    state.transcript = transcript("   ")
    await tap("share-text")
    expect(share).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("search.share.noTranscript")
  })
})

describe("useShareTrack — the transcript as PDF", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    state.appLanguage = "en"
    state.libraryLanguages = ["en"]
    state.availableLanguages = ["en"]
    state.availableLanguagesThrows = false
    state.trackThrows = false
    state.track = track()
    state.transcriptPath = "transcripts/track_1/en.json"
    state.subscribed = true
    state.resolved = true
    state.proGranted = true
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders the PDF and hands the local file to the share sheet", async () => {
    await tap("share-pdf")

    expect(prepareLocalPdf).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: TRACK, lang: "en", transcriptKey: state.transcriptPath })
    )
    expect(share.mock.calls[0][0]).toMatchObject({
      url: "file:///local/track_1.pdf",
      title: "A lecture",
    })
  })

  it("gets the track sheet out of the paywall's way for a non-subscriber", async () => {
    state.subscribed = false
    state.proGranted = false
    await tap("share-pdf")

    expect(trackSheetClose).toHaveBeenCalled()
    expect(prepareLocalPdf).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
  })

  it("leaves the track sheet alone for a subscriber", async () => {
    await tap("share-pdf")
    expect(trackSheetClose).not.toHaveBeenCalled()
  })

  it("renders the PDF once a non-subscriber buys at the paywall", async () => {
    state.subscribed = false
    state.proGranted = true
    await tap("share-pdf")

    expect(prepareLocalPdf).toHaveBeenCalled()
    expect(share).toHaveBeenCalled()
  })

  it("says there is no transcript when the file it should render is missing", async () => {
    state.transcriptPath = null
    await tap("share-pdf")

    expect(prepareLocalPdf).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("search.share.noTranscript")
  })
})
