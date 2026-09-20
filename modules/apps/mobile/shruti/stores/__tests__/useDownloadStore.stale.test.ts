import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { TrackId } from "@lib/domain/core.js"

/**
 * Reconciling the rows a killed session left mid-transfer (issue #1755).
 *
 * `failStaleDownloads()` demotes every row still in "downloading" at launch
 * and blanks its `local_path`, without ever asking whether the bytes arrived.
 * On iOS they routinely do: the transfer runs in a background `URLSession`
 * that goes on delivering while the app is suspended or killed, so the file
 * lands while the row still says "downloading". The next launch demoted that
 * row and forgot where the file was — a lecture playing from disk while its
 * row read "not downloaded", and a tap that raised the storage-full notice
 * (#1744).
 */

const mocks = vi.hoisted(() => ({
  SERVER: { id: "test", urlTemplate: "https://cdn.test/{path}" },
  listReady: vi.fn(),
  failStaleDownloads: vi.fn(),
  getAudioSizesBytes: vi.fn(),
  getByIds: vi.fn(),
  upsert: vi.fn(),
  resolveLocalUrl: vi.fn(),
  deleteFile: vi.fn(),
  downloadMedia: vi.fn(),
  toastError: vi.fn(),
  toastAction: vi.fn(),
  limitBytes: { value: 0 } as { value: number },
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: { value: mocks.SERVER },
    setActiveServer: vi.fn(),
    audioPlayer: { getQueueState: vi.fn(async () => null) },
    mediaDownloader: {
      resolveLocalUrl: mocks.resolveLocalUrl,
      download: vi.fn(async () => "file://local"),
      delete: mocks.deleteFile,
      cancel: vi.fn(async () => {}),
    },
    repositories: () => ({
      mediaItems: {
        listReady: mocks.listReady,
        listEvictPending: vi.fn(async () => []),
        upsert: mocks.upsert,
        failStaleDownloads: mocks.failStaleDownloads,
      },
      tracks: {
        getAudioSizesBytes: mocks.getAudioSizesBytes,
        getById: vi.fn(async () => null),
        getByIds: mocks.getByIds,
        getTranscriptPath: vi.fn(async () => null),
      },
      transcripts: { get: vi.fn(), listLanguages: vi.fn(async () => []) },
      unitOfWork: { run: vi.fn() },
    }),
    storagePublicUrl: { get: (path: string) => path },
    filesStorage: { delete: vi.fn(async () => {}) },
  }),
}))

vi.mock("@shruti/composables/useConfig.js", async () => {
  const { ref } = await import("vue")
  mocks.limitBytes = ref(0)
  return { useConfig: () => mocks.limitBytes }
})

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: mocks.toastError, action: mocks.toastAction }),
}))
vi.mock("@usecases/downloads/downloadMedia.js", () => ({ downloadMedia: mocks.downloadMedia }))
vi.mock("@usecases/downloads/removeDownloadedMedia.js", () => ({
  removeDownloadedMedia: vi.fn(),
}))
vi.mock("@usecases/downloads/removeDownloadedTranscripts.js", () => ({
  removeDownloadedTranscripts: vi.fn(),
}))
vi.mock("../downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [mocks.SERVER] }),
}))
vi.mock("../downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn(async () => {}) }),
}))
vi.mock("@shruti/composables/useWantedTranscriptLanguages.js", () => ({
  // The store watches this to backfill transcripts when the user picks up a
  // new language; `ready: false` keeps that watcher out of these tests.
  useWantedTranscriptLanguages: () => ({ languages: { value: [] }, ready: { value: false } }),
}))

import { useDownloadStore } from "../useDownloadStore.js"
import { useDownloadQuotaStore } from "../useDownloadQuotaStore.js"

const MB = 1024 * 1024
const T1 = "t1" as TrackId
const AUDIO_PATH = "public/tracks/t1/audio/clean.mp3"
const ON_DISK = "file:///data/shruti/public/tracks/t1/audio/clean.mp3"

/** A catalog entry for T1 whose playable variant carries `filesize` bytes. */
function catalogTrack(filesize: number | null): unknown {
  return {
    id: T1,
    variants: [
      {
        trackId: T1,
        language: "ru",
        title: "t1",
        audios: [],
        audio: { path: AUDIO_PATH, filesize, duration: null, kind: "clean" },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

/** The row shape `failStaleDownloads` hands back for what it demoted. */
function demoted(trackId: TrackId): unknown {
  return { id: "media-1", trackId, kind: "original", state: "failed", localPath: null }
}

/** Let the deferred reconciliation run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.limitBytes.value = 0
  mocks.listReady.mockResolvedValue([])
  mocks.failStaleDownloads.mockResolvedValue([])
  mocks.getAudioSizesBytes.mockResolvedValue(new Map())
  mocks.getByIds.mockResolvedValue(new Map())
  mocks.upsert.mockResolvedValue(undefined)
  mocks.toastError.mockResolvedValue(undefined)
  mocks.toastAction.mockResolvedValue({ kind: "expired" })
  mocks.resolveLocalUrl.mockResolvedValue(null)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.downloadMedia.mockResolvedValue({
    ok: true,
    value: { server: mocks.SERVER, mediaItem: { localPath: "file://local" } },
  })
})

describe("useDownloadStore — the rows a killed session left mid-transfer", () => {
  it("restores one whose bytes landed while the app was gone", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    mocks.getByIds.mockResolvedValue(new Map([[T1, catalogTrack(30 * MB)]]))
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.hydrate()
    await settle()

    // Addressed by the file's own key, exactly as `ensureDownloaded` probes it.
    expect(mocks.resolveLocalUrl).toHaveBeenCalledWith(`https://cdn.test/${AUDIO_PATH}`)
    expect(mocks.upsert).toHaveBeenCalledWith(T1, "ready", ON_DISK)
    expect(store.getState(T1)).toBe("completed")
    // And the bytes stop being invisible to the budget.
    expect(useDownloadQuotaStore().usedBytes).toBe(30 * MB)
  })

  it("leaves one whose bytes never landed failed", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    mocks.getByIds.mockResolvedValue(new Map([[T1, catalogTrack(30 * MB)]]))
    mocks.resolveLocalUrl.mockResolvedValue(null)

    const store = useDownloadStore()
    await store.hydrate()
    await settle()

    expect(mocks.failStaleDownloads).toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(store.getState(T1)).not.toBe("completed")
    expect(useDownloadQuotaStore().usedBytes).toBe(0)
  })

  /* ------------------------- the validity rule ------------------------- */

  /**
   * Presence at the destination IS the rule, and it is not weakened by the
   * catalog's size being unknown — a personal-library import has no
   * `filesize` at all. A size gate would refuse exactly the tracks the disk
   * is the only source of truth for; the budget's own estimate covers the
   * missing number, as it does everywhere else.
   */
  it("adopts one the catalog has no size for, charging the estimate", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    mocks.getByIds.mockResolvedValue(new Map([[T1, catalogTrack(null)]]))
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.hydrate()
    await settle()

    expect(store.getState(T1)).toBe("completed")
    expect(useDownloadQuotaStore().usedBytes).toBe(40 * MB)
  })

  /**
   * The other side of the same rule: presence is asked about the file the
   * catalog names, so a row whose track carries no playable audio (dropped
   * from the catalog, translation-only) cannot be validated at all and keeps
   * the demotion.
   */
  it("leaves one failed when the catalog cannot name its file", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    mocks.getByIds.mockResolvedValue(new Map())
    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)

    const store = useDownloadStore()
    await store.hydrate()
    await settle()

    expect(mocks.resolveLocalUrl).not.toHaveBeenCalled()
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(store.getState(T1)).not.toBe("completed")
  })

  /**
   * A row that failed for real must not be adopted from here either — the
   * file its last attempt left behind may be a CDN error page written to the
   * lecture's own path (#1722), and adopting it would make a corrupt download
   * permanent. That is the guard the drain's tail walk already holds; the
   * reconciliation must not reintroduce from the launch side what the queue
   * side refuses.
   */
  it("does not adopt the leftovers of a row that failed for real", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    // Hold the catalog read open so the attempt below lands inside the window
    // the deferred reconciliation runs in.
    let releaseCatalog!: () => void
    mocks.getByIds.mockReturnValue(
      new Promise((resolve) => {
        releaseCatalog = () => resolve(new Map([[T1, catalogTrack(30 * MB)]]))
      })
    )

    const store = useDownloadStore()
    await store.hydrate()

    // The user taps the lecture and the attempt fails, leaving a file at the
    // lecture's own path — on iOS that is the CDN's error document (#1722).
    mocks.downloadMedia.mockResolvedValue({ ok: false, error: "transfer-failed" })
    await store.ensureDownloaded(T1, AUDIO_PATH, 30 * MB)
    expect(store.getState(T1)).toBe("failed")

    mocks.resolveLocalUrl.mockResolvedValue(ON_DISK)
    mocks.upsert.mockClear()
    releaseCatalog()
    await settle()

    expect(store.getState(T1)).toBe("failed")
    expect(mocks.upsert).not.toHaveBeenCalledWith(T1, "ready", ON_DISK)
  })

  /**
   * `hydrate()` is on the boot critical path and several screens call it
   * defensively, so the probes hang off it rather than inside it — one
   * unreachable catalog read must not be able to hold a cold start open.
   */
  it("does not make the launch wait on the probes", async () => {
    mocks.failStaleDownloads.mockResolvedValue([demoted(T1)])
    mocks.getByIds.mockReturnValue(new Promise(() => {}))

    const store = useDownloadStore()
    await store.hydrate()

    expect(mocks.resolveLocalUrl).not.toHaveBeenCalled()
    expect(store.hydrationError).toBeNull()
  })
})
