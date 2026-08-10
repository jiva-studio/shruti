import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import { err, ok } from "@kit/core"
import type { TrackId } from "@lib/domain/core.js"
import type { CdnServer } from "@lib/domain/servers.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const SERVER: CdnServer = {
  id: "server-a",
  name: "Server A",
  urlTemplate: "https://a.example.com/{path}",
  shareAudioUrl: "https://a.example.com/excerpts",
  shareVideoUrl: "https://a.example.com/reels",
  authBaseUrl: "https://a.example.com/auth",
  chatBaseUrl: "https://a.example.com",
}

// The transfer itself is exercised in the use case's own tests; here we
// drive its RESULT, because what is under test is how the store paints a
// cancelled transfer versus a failed one.
const downloadMediaMock = vi.fn()
vi.mock("@usecases/downloads/downloadMedia.js", () => ({
  downloadMedia: (...args: unknown[]) => downloadMediaMock(...args),
}))

const resolveLocalUrl = vi.fn<(url: string) => Promise<string | null>>(async () => null)
const upsert = vi.fn(async () => ({}))
const activeServer = ref(SERVER)

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer,
    setActiveServer: vi.fn(),
    mediaDownloader: {
      download: vi.fn(),
      delete: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      resolveLocalUrl: (url: string) => resolveLocalUrl(url),
    },
    repositories: () => ({
      mediaItems: { upsert, listReady: async () => [], failStaleDownloads: async () => {} },
      unitOfWork: { run: async (fn: () => unknown) => fn() },
      tracks: {},
      transcripts: {},
    }),
    storagePublicUrl: { get: (p: string) => p },
    filesStorage: { delete: async () => {} },
  }),
}))

const quota = {
  limitBytes: 0,
  ensureMeasured: vi.fn(async () => {}),
  sizeOf: () => 1000,
  hasRoomFor: () => true,
  reserve: vi.fn(),
  settle: vi.fn(),
  forget: vi.fn(),
  refresh: vi.fn(async () => {}),
  reset: vi.fn(),
}
vi.mock("@shruti/stores/useDownloadQuotaStore.js", () => ({
  useDownloadQuotaStore: () => quota,
}))
vi.mock("@shruti/stores/downloads/useServerFallback.js", () => ({
  useServerFallback: () => ({ candidates: () => [SERVER] }),
}))
vi.mock("@shruti/stores/downloads/useTranscriptPrefetch.js", () => ({
  useTranscriptPrefetch: () => ({ prefetchForTrack: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))

import { useDownloadStore } from "../useDownloadStore.js"

const TRACK = "t-1" as TrackId
const PATH = "public/tracks/t-1/audio/original.mp3"

describe("useDownloadStore — how a settled transfer is painted", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    downloadMediaMock.mockReset()
    resolveLocalUrl.mockClear()
    upsert.mockClear()
  })

  it("drops a cancelled download back to idle — no red retry affordance", async () => {
    downloadMediaMock.mockResolvedValue(err("cancelled"))
    const store = useDownloadStore()

    const result = await store.ensureDownloaded(TRACK, PATH)

    expect(result).toBeNull()
    // The user removed / archived the track: "failed" would paint a red X
    // and a "Download again" button on a row they deliberately dropped.
    expect(store.getState(TRACK)).toBe("idle")
    expect(store.getProgress(TRACK)).toBe(0)
  })

  it("still paints a genuine transfer failure as failed", async () => {
    downloadMediaMock.mockResolvedValue(err("transfer-failed"))
    const store = useDownloadStore()

    expect(await store.ensureDownloaded(TRACK, PATH)).toBeNull()
    expect(store.getState(TRACK)).toBe("failed")
  })

  it("marks a completed download as completed", async () => {
    downloadMediaMock.mockResolvedValue(
      ok({ mediaItem: { localPath: "file:///data/x.mp3" }, server: SERVER })
    )
    const store = useDownloadStore()

    expect(await store.ensureDownloaded(TRACK, PATH)).toBe("file:///data/x.mp3")
    expect(store.getState(TRACK)).toBe("completed")
  })
})
