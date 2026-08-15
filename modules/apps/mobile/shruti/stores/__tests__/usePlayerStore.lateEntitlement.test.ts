import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { reactive, ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type {
  AudioProgressListener,
  AudioQueueItem,
  AudioQueueState,
  AudioStatus,
} from "@ports/app/audioPlayer.js"

/**
 * Continuous playback is a Pro feature and `loadTrack` reads the entitlement
 * exactly once — when it arms the queue. RevenueCat's reconcile window is
 * entered on EVERY cold start, so a subscriber who pressed play inside it got
 * single-track playback for the whole queue session, with no recovery short of
 * rebuilding the queue (#1864).
 *
 * The recovery is a re-arm on the unknown→subscribed edge rather than an await
 * before the first play, so nothing is delayed — and it must not restart what
 * is already playing.
 */

/* --------------------------------------------------------------------- */
/*                              Fixtures                                 */
/* --------------------------------------------------------------------- */

function track(id: string): Track {
  return {
    id: id as TrackId,
    authorId: null,
    locationId: null,
    date: "2020-01-01",
    hidden: false,
    references: [],
    tagIds: [],
    topicIds: [],
    variants: [
      {
        trackId: id as TrackId,
        language: "en",
        title: `Lecture ${id}`,
        audios: [],
        audio: {
          path: `public/tracks/${id}/audio/original.mp3`,
          filesize: 1,
          duration: 60_000,
          kind: "original",
        },
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

const TRACKS = new Map<string, Track>([
  ["t-a", track("t-a")],
  ["t-b", track("t-b")],
  ["t-c", track("t-c")],
])

const QUEUE: AudioQueueItem[] = [
  { itemId: "i-a", url: "file:///a.mp3", title: "Lecture t-a", author: "" },
  { itemId: "i-b", url: "file:///b.mp3", title: "Lecture t-b", author: "" },
  { itemId: "i-c", url: "file:///c.mp3", title: "Lecture t-c", author: "" },
]

const IDLE: AudioQueueState = {
  currentItemId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  queueCount: 0,
  events: [],
}

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

let progressListener: AudioProgressListener | null = null
let queueState: AudioQueueState = IDLE

const audioPlayer = {
  open: vi.fn(async () => {}),
  play: vi.fn(async () => {}),
  togglePause: vi.fn(async () => {}),
  seek: vi.fn(async () => {}),
  seekBy: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  setMix: vi.fn(async () => {}),
  setPlaybackRate: vi.fn(async () => {}),
  setProgressInterval: vi.fn(async () => {}),
  setQueue: vi.fn<(items: AudioQueueItem[], startIndex: number, startAt: number) => Promise<void>>(
    async () => {}
  ),
  appendToQueue: vi.fn(async () => {}),
  getQueueState: vi.fn(async () => queueState),
  ackEvents: vi.fn(async () => {}),
  skipToNext: vi.fn(async () => {}),
  skipToPrevious: vi.fn(async () => {}),
  onProgress: (listener: AudioProgressListener) => {
    progressListener = listener
    return () => {
      progressListener = null
    }
  },
  onTransition: () => () => {},
  onPositionJump: () => () => {},
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ audioPlayer, repositories: () => ({}) }),
}))

const itemToTrack = new Map([
  ["i-a", "t-a"],
  ["i-b", "t-b"],
  ["i-c", "t-c"],
])
const playlist = {
  buildQueueFrom: vi.fn(async (fromItemId: string) => {
    const start = QUEUE.findIndex((q) => q.itemId === fromItemId)
    return start < 0 ? [] : QUEUE.slice(start).map((q) => ({ ...q }))
  }),
  resolveTrackForItemId: vi.fn(async (id: string) => TRACKS.get(itemToTrack.get(id) ?? "")),
  patchProgress: vi.fn(),
  getCompletedAt: () => null,
}
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))

// A reactive stand-in for the purchases store: `isSubscribed` reads false
// while RevenueCat is still reconciling and flips true when it answers.
const purchases = reactive({ isSubscribed: ref(false) })
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => purchases,
}))
vi.mock("@shruti/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: null, show: vi.fn() }),
}))
vi.mock("@shruti/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({
    markPending: vi.fn(),
    clearPending: vi.fn(),
    ensureDownloaded: async () => "file:///a.mp3",
    evict: vi.fn(async () => true),
    markEvictPending: vi.fn(async () => {}),
  }),
}))
vi.mock("@shruti/composables/useConfig.js", () => ({
  useConfig: (_key: string, initial: unknown) => ref(initial),
}))
let autoPlayNext = true
vi.mock("@shruti/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ref(autoPlayNext),
}))
vi.mock("@shruti/stores/player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    flushOnHide: vi.fn(),
    finishCurrent: vi.fn(async () => {}),
    recordSeek: vi.fn(async () => {}),
    hasActive: () => false,
    activeItemId: () => null,
  }),
}))
vi.mock("@shruti/stores/player/usePlayerResumePosition.js", () => ({
  usePlayerResumePosition: () => ({ resolve: async () => 0 }),
}))
vi.mock("@shruti/stores/player/usePlayerQueueReconcile.js", () => ({
  usePlayerQueueReconcile: () => ({ reconcileAndAck: vi.fn(async () => {}) }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  registerAudioSource: () => ({ claim: vi.fn(), release: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock("@capacitor/app", () => ({
  App: { addListener: async () => ({ remove: vi.fn() }) },
}))

import { usePlayerStore } from "../usePlayerStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                 */
/* --------------------------------------------------------------------- */

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function emitProgress(status: AudioStatus): void {
  progressListener?.(status)
}

/**
 * Press play on A while the entitlement is still unknown: the store takes the
 * single-track `open()` path, and the engine ends up holding one item.
 */
async function playSingleTrackA(): Promise<ReturnType<typeof usePlayerStore>> {
  const player = usePlayerStore()
  await settle() // let the startup drain finish before we describe the engine
  await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
  queueState = {
    currentItemId: "i-a",
    positionMs: 7_000,
    durationMs: 60_000,
    playing: true,
    queueCount: 1,
    events: [],
  }
  emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })
  audioPlayer.setQueue.mockClear()
  return player
}

/* --------------------------------------------------------------------- */
/*                                Tests                                  */
/* --------------------------------------------------------------------- */

describe("usePlayerStore — a Pro entitlement that resolves after play", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    queueState = IDLE
    purchases.isSubscribed = false
    autoPlayNext = true
    progressListener = null
    playlist.buildQueueFrom.mockClear()
    for (const fn of Object.values(audioPlayer)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear()
    }
  })

  it("hands the playlist tail over once the entitlement lands", async () => {
    const player = await playSingleTrackA()
    expect(audioPlayer.open).toHaveBeenCalled()
    expect(audioPlayer.setQueue).not.toHaveBeenCalled()

    purchases.isSubscribed = true
    await settle()

    const [items, startIndex, startAt] = audioPlayer.setQueue.mock.calls[0]!
    expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b", "i-c"])
    expect(startIndex).toBe(0)
    // The engine's own live position, not 0 and not the stale progress tick —
    // re-arming must not restart the lecture the user is listening to.
    expect(startAt).toBe(7_000)
    expect(player.itemId).toBe("i-a")

    // Continuous playback is genuinely on now: the transport works.
    await player.playNext()
    expect(audioPlayer.skipToNext).toHaveBeenCalled()
  })

  it("defers the handover while paused, and lands it on the next resume", async () => {
    const player = await playSingleTrackA()
    queueState = { ...queueState, playing: false }
    emitProgress({ itemId: "i-a", playing: false, position: 7_000, duration: 60_000 })

    purchases.isSubscribed = true
    await settle()

    // `setQueue` starts playback by itself — a paused player must stay paused.
    expect(audioPlayer.setQueue).not.toHaveBeenCalled()

    await player.togglePause()

    expect(audioPlayer.togglePause).not.toHaveBeenCalled()
    const [items] = audioPlayer.setQueue.mock.calls[0]!
    expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b", "i-c"])
  })

  it("leaves the engine alone when the toggle is off", async () => {
    autoPlayNext = false
    await playSingleTrackA()

    purchases.isSubscribed = true
    await settle()

    expect(audioPlayer.setQueue).not.toHaveBeenCalled()
    expect(playlist.buildQueueFrom).not.toHaveBeenCalled()
  })

  it("leaves the engine alone when nothing is loaded", async () => {
    usePlayerStore()
    await settle()

    purchases.isSubscribed = true
    await settle()

    expect(audioPlayer.setQueue).not.toHaveBeenCalled()
  })

  it("leaves the engine alone when it is on something else", async () => {
    await playSingleTrackA()
    // The engine moved on under us (a restored queue, a native advance): what
    // it holds did not come from this store's single-track open.
    queueState = { ...queueState, currentItemId: "i-zz" }

    purchases.isSubscribed = true
    await settle()

    expect(audioPlayer.setQueue).not.toHaveBeenCalled()
  })

  it("does not re-arm a queue that was already handed over", async () => {
    purchases.isSubscribed = true
    const player = usePlayerStore()
    await settle()
    await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
    expect(audioPlayer.setQueue).toHaveBeenCalledOnce()
    queueState = {
      currentItemId: "i-a",
      positionMs: 7_000,
      durationMs: 60_000,
      playing: true,
      queueCount: 3,
      events: [],
    }

    // An entitlement refresh that re-confirms Pro is not a new edge, and even
    // a false→true flicker must not push the queue again mid-lecture.
    purchases.isSubscribed = false
    purchases.isSubscribed = true
    await settle()

    expect(audioPlayer.setQueue).toHaveBeenCalledOnce()
  })
})
