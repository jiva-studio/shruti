// @vitest-environment jsdom
import { createApp, reactive, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { smartLibraryToggled } from "@ui/features/settings/smartLibrary.js"

/**
 * The sweep deletes downloaded audio, so it must obey the switch the user
 * actually sees. These tests drive the composable through its two config
 * values — the Smart Library target and the archive delay — and assert that
 * a target of 0 keeps it dark no matter what the delay says (#1624).
 */
const ctx = vi.hoisted(() => ({
  config: null as unknown as Map<string, Ref<unknown>>,
  playlist: null as unknown as { completedAtMap: Map<PlaylistItemId, number | null> },
  purchases: null as unknown as { isSubscribed: boolean },
  listActive: null as unknown as ReturnType<typeof vi.fn>,
  archive: null as unknown as ReturnType<typeof vi.fn>,
  evict: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (key: string, initial: unknown) => {
    const existing = ctx.config.get(key)
    if (existing) return existing
    const created = ref(initial)
    ctx.config.set(key, created)
    return created
  },
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ctx.playlist,
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ctx.purchases,
}))
vi.mock("@shruti/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({ evict: ctx.evict }),
}))
vi.mock("@usecases/playlist/archivePlaylistItem.js", () => ({
  archivePlaylistItem: (...args: unknown[]) =>
    (ctx.archive as unknown as (...a: unknown[]) => unknown)(...args),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      playlistItems: { listActive: ctx.listActive },
      tracks: { getByIds: async () => new Map([[TRACK_ID, track(TRACK_ID)]]) },
      listeningSessions: {
        getCompletedAtForItems: async () => new Map([[ITEM_ID, COMPLETED_AT_SEC]]),
      },
      unitOfWork: {},
    }),
  }),
}))

import {
  AUTO_ARCHIVE_DELAY_KEY,
  useAutoArchiveSweep,
  type AutoArchiveDelay,
} from "../useAutoArchiveSweep.js"
import { AUTO_DOWNLOAD_TARGET_SECONDS_KEY } from "../useAutoDownloadLoop.js"

const ITEM_ID = "item-1" as PlaylistItemId
const TRACK_ID = "track-1" as TrackId
const NOW = 10 * 86_400_000
/** Two days ago — past every delay bucket. */
const COMPLETED_AT_SEC = (NOW - 2 * 86_400_000) / 1000

function track(id: TrackId): Track {
  return {
    id,
    authorId: null,
    locationId: null,
    date: "1970-01-01" as Track["date"],
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        trackId: id,
        language: "en" as Track["variants"][number]["language"],
        title: id,
        audios: [{ path: "", filesize: null, duration: 60_000, kind: "original" }],
        audio: { path: "", filesize: null, duration: 60_000, kind: "original" },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

function setConfig(targetSeconds: number, archiveDelay: AutoArchiveDelay): void {
  ;(ctx.config.get(AUTO_DOWNLOAD_TARGET_SECONDS_KEY) as Ref<number>).value = targetSeconds
  ;(ctx.config.get(AUTO_ARCHIVE_DELAY_KEY) as Ref<AutoArchiveDelay>).value = archiveDelay
}

function mountSweep(): { app: ReturnType<typeof createApp>; sweep: () => Promise<void> } {
  let sweep!: () => Promise<void>
  const app = createApp({
    setup() {
      sweep = useAutoArchiveSweep().sweep
      return () => null
    },
  })
  app.mount(document.createElement("div"))
  return { app, sweep }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Mimic a lecture finishing while the app is open. */
async function completeALecture(): Promise<void> {
  ctx.playlist.completedAtMap.set(ITEM_ID, COMPLETED_AT_SEC)
  await vi.advanceTimersByTimeAsync(1000)
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  ctx.config = new Map<string, Ref<unknown>>([
    [AUTO_DOWNLOAD_TARGET_SECONDS_KEY, ref(30 * 60)],
    [AUTO_ARCHIVE_DELAY_KEY, ref("1d")],
  ])
  ctx.playlist = reactive({
    completedAtMap: new Map<PlaylistItemId, number | null>(),
    refresh: vi.fn(async () => {}),
  })
  ctx.purchases = reactive({ isSubscribed: true })
  ctx.listActive = vi.fn(async () => [{ id: ITEM_ID, trackId: TRACK_ID }])
  ctx.archive = vi.fn(async () => undefined)
  ctx.evict = vi.fn(async () => true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useAutoArchiveSweep — master switch", () => {
  it("archives a finished lecture while Smart Library is on", async () => {
    const { app, sweep } = mountSweep()
    await sweep()
    expect(ctx.archive).toHaveBeenCalledWith({ itemId: ITEM_ID }, expect.anything())
    expect(ctx.evict).toHaveBeenCalledWith(TRACK_ID)
    app.unmount()
  })

  it("does not sweep after the toggle is switched off", async () => {
    const { app, sweep } = mountSweep()
    await sweep()
    expect(ctx.archive).toHaveBeenCalledOnce()

    // Exactly what the dialog persists when the user flips the switch off.
    const next = smartLibraryToggled(false, { targetSeconds: 30 * 60, archiveDelay: "1d" }, 30 * 60)
    setConfig(next.targetSeconds, next.archiveDelay)
    ctx.listActive.mockClear()
    ctx.archive.mockClear()
    ctx.evict.mockClear()

    await completeALecture()
    await sweep()

    expect(ctx.listActive).not.toHaveBeenCalled()
    expect(ctx.archive).not.toHaveBeenCalled()
    expect(ctx.evict).not.toHaveBeenCalled()
    app.unmount()
  })

  it("stays dark for builds that left a live delay behind the off switch", async () => {
    setConfig(0, "1d")
    const { app, sweep } = mountSweep()

    await completeALecture()
    await sweep()

    expect(ctx.listActive).not.toHaveBeenCalled()
    expect(ctx.archive).not.toHaveBeenCalled()
    app.unmount()
  })

  it("resumes when Smart Library is turned back on with a delay chosen", async () => {
    setConfig(0, "off")
    const { app } = mountSweep()
    await flush()
    expect(ctx.archive).not.toHaveBeenCalled()

    setConfig(30 * 60, "immediate")
    await flush()

    expect(ctx.archive).toHaveBeenCalledWith({ itemId: ITEM_ID }, expect.anything())
    app.unmount()
  })
})
