import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

/**
 * #1889 — Library → Share → Audio.
 *
 * The modal it presents has no `backdropDismiss` and no cancel, and behind it
 * runs a full-lecture download that was passed no `AbortSignal` and had no
 * watchdog. A transfer that stalls without emitting `failed` therefore held
 * both the UI and the app-wide share slot until a force-quit. Two things had
 * to become true: the 3-second handoff Notes already had (the modal goes away
 * and the tab indicator lights instead), and a stalled transfer failing on its
 * own so the slot is always given back.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const TRACK = "track_1" as TrackId
const AUDIO_PATH = "public/tracks/track_1/audio/original.mp3"
const AUDIO_URL = "https://cdn.example.com/public/tracks/track_1/audio/original.mp3"

const track: Track = {
  id: TRACK,
  authorId: null,
  locationId: null,
  date: "2020-01-01",
  hidden: false,
  references: [],
  tagIds: [],
  topicIds: [],
  variants: [
    {
      trackId: TRACK,
      language: "en" as LanguageCode,
      title: "A lecture",
      audios: [{ path: AUDIO_PATH, filesize: 42, duration: 1000, kind: "original" }],
      audio: { path: AUDIO_PATH, filesize: 42, duration: 1000, kind: "original" },
      transcript: null,
      outline: null,
      description: null,
    },
  ],
}

interface SheetButton {
  text: string
  handler?: () => void
}
let sheetButtons: SheetButton[] = []

const modal = {
  message: "",
  present: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  actionSheetController: {
    create: vi.fn(async (opts: { buttons: SheetButton[] }) => {
      sheetButtons = opts.buttons
      return { present: vi.fn(async () => {}), onDidDismiss: vi.fn(async () => {}) }
    }),
  },
  loadingController: { create: vi.fn(async () => modal) },
}))

const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>()
const download =
  vi.fn<
    (
      url: string,
      onProgress?: (r: number, t: number, d: boolean) => void,
      signal?: AbortSignal
    ) => Promise<string>
  >()
const share = vi.fn(async () => {})

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      tracks: { getById: vi.fn(async () => track) },
      transcripts: { availableLanguages: vi.fn(async () => []) },
    }),
    storagePublicUrl: { get: () => AUDIO_URL },
    mediaDownloader: { resolveLocalUrl, download },
    shareService: { share },
    haptics: { impact: vi.fn() },
    createStallGuard,
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@shruti/composables/useShareTranscript.js", () => ({
  useShareTranscript: () => ({ prepareLocalPdf: vi.fn() }),
}))
vi.mock("@shruti/stores/useOverlaysStore.js", () => ({
  useOverlaysStore: () => ({ actionSheetOpen: false }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({ sourcesById: new Map(), tagsById: new Map() }),
}))
const adoptCachedFile = vi.fn(async () => {})
vi.mock("@shruti/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({ adoptCachedFile }),
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ resolved: true, isSubscribed: true, ensurePro: async () => true }),
}))
vi.mock("@shruti/stores/useTrackSheetStore.js", () => ({
  useTrackSheetStore: () => ({ close: vi.fn() }),
}))

const toastInfo = vi.fn(async () => {})
const toastError = vi.fn(async () => {})
vi.mock("@kit/composables", () => ({
  useToast: () => ({ info: toastInfo, error: toastError, success: vi.fn(), show: vi.fn() }),
}))

const tryStart = vi.fn(() => true)
const markInBackground = vi.fn()
const finish = vi.fn()
vi.mock("@shruti/stores/useShareJobStore.js", () => ({
  useShareJobStore: () => ({ tryStart, markInBackground, finish }),
}))

import { DOWNLOAD_STALL_TIMEOUT_MS, createStallGuard } from "@infra/watchDownload.js"
import { useShareTrack } from "../useShareTrack.js"

/* --------------------------------------------------------------------- */
/*                                Helpers                                */
/* --------------------------------------------------------------------- */

/** Open the track's Share sheet and tap "Audio". */
async function tapShareAudio(): Promise<void> {
  const { presentShareMenu } = useShareTrack()
  await presentShareMenu(TRACK)
  const audio = sheetButtons.find((b) => b.text === "search.share.audio")
  expect(audio).toBeDefined()
  audio!.handler!()
}

/** Let every already-resolved promise chain settle under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe("useShareTrack — share audio (#1889)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    modal.message = ""
    resolveLocalUrl.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("hands the download to the background after 3 s, and still releases the slot", async () => {
    // A transfer that reports bytes forever but never completes: the modal has
    // no way out of its own, so the handoff is the only thing that frees the UI.
    let reject!: (e: Error) => void
    download.mockImplementation(
      (_url, onProgress, signal) =>
        new Promise<string>((_resolve, rej) => {
          reject = rej
          onProgress?.(50, 100, true)
          signal?.addEventListener("abort", () => rej(new Error("aborted")))
        })
    )

    await tapShareAudio()
    await flush()
    expect(markInBackground).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3_000)
    await flush()

    // The UI is given back and the tab indicator explains why other shares
    // are being refused — but the slot is still held, because the work runs.
    expect(markInBackground).toHaveBeenCalledTimes(1)
    expect(modal.dismiss).toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith("notes.shareInBackground")
    expect(finish).not.toHaveBeenCalled()

    reject(new Error("network gone"))
    await flush()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("aborts a stalled transfer instead of hanging on it forever", async () => {
    let seenSignal: AbortSignal | undefined
    download.mockImplementation(
      (_url, _onProgress, signal) =>
        new Promise<string>((_resolve, rej) => {
          seenSignal = signal
          // No progress, no `completed`, no `failed` — the parked-job shape.
          signal?.addEventListener("abort", () => rej(new Error("aborted")))
        })
    )

    await tapShareAudio()
    await vi.advanceTimersByTimeAsync(3_000)
    await flush()
    expect(seenSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS)
    await flush()

    expect(seenSignal?.aborted).toBe(true)
    expect(toastError).toHaveBeenCalledWith("search.share.error")
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("does not kill a slow-but-live download: progress re-arms the watchdog", async () => {
    let settle!: (uri: string) => void
    let ping!: () => void
    download.mockImplementation(
      (_url, onProgress, signal) =>
        new Promise<string>((resolve, rej) => {
          settle = resolve
          let received = 0
          ping = () => onProgress?.((received += 10), 100, true)
          signal?.addEventListener("abort", () => rej(new Error("aborted")))
        })
    )

    await tapShareAudio()
    await flush()

    // Five times the stall budget of elapsed time, never silent for it.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS - 1_000)
      ping()
      await flush()
    }
    expect(toastError).not.toHaveBeenCalled()

    settle("file:///local/track_1.mp3")
    await flush()

    expect(share).toHaveBeenCalledTimes(1)
    expect(adoptCachedFile).toHaveBeenCalled()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("keeps the fast path free of a handoff: a cached copy shares straight away", async () => {
    resolveLocalUrl.mockResolvedValue("file:///local/track_1.mp3")

    await tapShareAudio()
    await flush()

    expect(share).toHaveBeenCalledTimes(1)
    expect(markInBackground).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("refuses a second share while one is running, and says so", async () => {
    tryStart.mockReturnValueOnce(false)

    await tapShareAudio()
    await flush()

    expect(toastInfo).toHaveBeenCalledWith("notes.shareAlreadyInProgress")
    expect(download).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
  })
})
