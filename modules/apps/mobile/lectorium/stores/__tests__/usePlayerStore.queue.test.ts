import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type {
  AudioProgressListener,
  AudioQueueItem,
  AudioQueueState,
  AudioStatus,
} from "@ports/app/audioPlayer.js"

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

/** The queue `openTrack` hands to the engine: A (playing) → B → C. */
const QUEUE: AudioQueueItem[] = [
  { itemId: "i-a", url: "file:///a.mp3", title: "Lecture t-a", author: "" },
  { itemId: "i-b", url: "file:///b.mp3", title: "Lecture t-b", author: "" },
  { itemId: "i-c", url: "file:///c.mp3", title: "Lecture t-c", author: "" },
]

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

let progressListener: AudioProgressListener | null = null
let appActiveListener: ((state: { isActive: boolean }) => void) | null = null
let queueState: AudioQueueState = {
  currentItemId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  queueCount: 0,
  events: [],
}

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

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ audioPlayer, repositories: () => ({}) }),
}))

/** Items the active playlist still carries; archiving drops one from it. */
let activeItemIds = new Set(["i-a", "i-b", "i-c"])
const itemToTrack = new Map([
  ["i-a", "t-a"],
  ["i-b", "t-b"],
  ["i-c", "t-c"],
])

const playlist = {
  // Mirrors the real one: the tail of the ACTIVE list from the given item, so
  // an archived lecture can no longer be rebuilt into a queue.
  buildQueueFrom: vi.fn(async (fromItemId: string) => {
    const active = QUEUE.filter((q) => activeItemIds.has(q.itemId))
    const start = active.findIndex((q) => q.itemId === fromItemId)
    return start < 0 ? [] : active.slice(start).map((q) => ({ ...q }))
  }),
  getEntryByItemId: (id: string) =>
    activeItemIds.has(id)
      ? { item: { id, trackId: itemToTrack.get(id) }, track: TRACKS.get(itemToTrack.get(id)!) }
      : undefined,
  // The DB-backed lookup: still resolves an item archived while it was queued.
  resolveTrackForItemId: vi.fn(async (id: string) => TRACKS.get(itemToTrack.get(id) ?? "")),
  patchProgress: vi.fn(),
  getCompletedAt: () => null,
}
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))
/** Flipped by the tests that open a single track: without Pro (or with the
 *  auto-play-next toggle off) `loadTrack` takes the `open()` path. */
let isSubscribed = true
let autoPlayNext = true
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    get isSubscribed(): boolean {
      return isSubscribed
    },
  }),
}))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: null, show: vi.fn() }),
}))
const downloads = {
  markPending: vi.fn(),
  clearPending: vi.fn(),
  ensureDownloaded: async () => "file:///a.mp3",
  evict: vi.fn(async () => true),
  markEvictPending: vi.fn(async () => {}),
}
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => downloads,
}))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (_key: string, initial: unknown) => ref(initial),
}))
vi.mock("@lectorium/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ref(autoPlayNext),
}))

const finishCurrent = vi.fn(async () => {})
vi.mock("@lectorium/stores/player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    flushOnHide: vi.fn(),
    finishCurrent,
    recordSeek: vi.fn(async () => {}),
    hasActive: () => false,
    activeItemId: () => null,
  }),
}))
vi.mock("@lectorium/stores/player/usePlayerResumePosition.js", () => ({
  usePlayerResumePosition: () => ({ resolve: async () => 0 }),
}))
vi.mock("@lectorium/stores/player/usePlayerQueueReconcile.js", () => ({
  usePlayerQueueReconcile: () => ({ reconcileAndAck: vi.fn(async () => {}) }),
}))
vi.mock("@lectorium/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))
// The orchestrator's source registry is module-level: without this, the store
// built for the previous test still gets paused when this one starts playing.
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  registerAudioSource: () => ({ claim: vi.fn(), release: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: async (_event: string, listener: (state: { isActive: boolean }) => void) => {
      appActiveListener = listener
      return { remove: vi.fn() }
    },
  },
}))

import { releaseFromNativeQueue } from "@lectorium/services/nativeQueue.js"
import { usePlayerStore } from "../usePlayerStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                 */
/* --------------------------------------------------------------------- */

function emitProgress(status: AudioStatus): void {
  progressListener?.(status)
}

/** Open A with the whole tail handed to the engine, then start playing it. */
async function playQueueFromA(): Promise<ReturnType<typeof usePlayerStore>> {
  const player = usePlayerStore()
  await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
  emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })
  audioPlayer.setQueue.mockClear()
  return player
}

/** Let the un-awaited native drains run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Come back from the background — the `appStateChange` drain. */
async function resumeForeground(): Promise<void> {
  await vi.waitFor(() => expect(appActiveListener).not.toBeNull())
  appActiveListener?.({ isActive: true })
  await settle()
}

/** Pause the engine and let the progress tick catch up with it. */
function pauseEngine(): void {
  queueState = { ...queueState, playing: false }
  emitProgress({ itemId: "i-a", playing: false, position: 7_000, duration: 60_000 })
}

describe("usePlayerStore — the live native queue", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activeItemIds = new Set(["i-a", "i-b", "i-c"])
    queueState = {
      currentItemId: "i-a",
      positionMs: 7_000,
      durationMs: 60_000,
      playing: true,
      queueCount: 3,
      events: [],
    }
    isSubscribed = true
    autoPlayNext = true
    progressListener = null
    appActiveListener = null
    finishCurrent.mockClear()
    downloads.evict.mockClear()
    downloads.markEvictPending.mockClear()
    playlist.buildQueueFrom.mockClear()
    for (const fn of Object.values(audioPlayer)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear()
    }
  })

  describe("releasing an archived lecture", () => {
    it("rewrites the queue without it, from the engine's live position", async () => {
      const player = await playQueueFromA()

      const keepFile = await releaseFromNativeQueue("i-c" as PlaylistItemId)

      expect(keepFile).toBe(false)
      const [items, startIndex, startAt] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b"])
      expect(startIndex).toBe(0)
      // Not the last progress tick (5000) — setQueue restarts the item where
      // we tell it to, so a stale position would rewind the lecture.
      expect(startAt).toBe(7_000)
      expect(player.itemId).toBe("i-a")
    })

    it("keeps the audio of the lecture playing right now", async () => {
      await playQueueFromA()

      expect(await releaseFromNativeQueue("i-a" as PlaylistItemId)).toBe(true)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()
    })

    it("keeps the audio of an item behind the playhead, which skipping back reaches", async () => {
      const player = await playQueueFromA()
      // Advance onto B. A is now behind the playhead — and still in the queue
      // the engine is running, with the `file://` URL resolved when it was built.
      queueState = { ...queueState, currentItemId: "i-b", positionMs: 1_000 }
      await player.playNext()
      emitProgress({ itemId: "i-b", playing: true, position: 1_000, duration: 60_000 })
      audioPlayer.setQueue.mockClear()
      downloads.evict.mockClear()

      // The auto-archive sweep archives FINISHED lectures mid-playback; a
      // rewrite for those would restart the current one every time. So the
      // engine is left alone — but that is exactly why the file has to stay.
      expect(await releaseFromNativeQueue("i-a" as PlaylistItemId)).toBe(true)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      // Nothing auto-advances backwards, but the user does: `skipToPrevious`
      // from the lock screen, a Bluetooth remote, or this. The entry is still
      // in the engine's queue, so the audio must still be on disk (issue #1667).
      await player.playPrevious()

      expect(audioPlayer.skipToPrevious).toHaveBeenCalled()
      expect(downloads.evict).not.toHaveBeenCalled()
    })

    it("gives the behind-the-playhead file back once a rewrite has landed", async () => {
      const player = await playQueueFromA()
      queueState = { ...queueState, currentItemId: "i-b", positionMs: 1_000 }
      await player.playNext()
      emitProgress({ itemId: "i-b", playing: true, position: 1_000, duration: 60_000 })
      audioPlayer.setQueue.mockClear()
      downloads.evict.mockClear()

      await releaseFromNativeQueue("i-a" as PlaylistItemId)
      expect(downloads.evict).not.toHaveBeenCalled()

      // Archiving C rewrites the queue for its own sake — no restart of the
      // current lecture is added by A's debt, and A is out of the engine's
      // reach the moment that rewrite lands.
      await releaseFromNativeQueue("i-c" as PlaylistItemId)

      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-b"])
      expect(downloads.evict).toHaveBeenCalledWith("t-a" as TrackId)
    })

    it("does nothing for a lecture the engine never had", async () => {
      await playQueueFromA()

      expect(await releaseFromNativeQueue("i-zz" as PlaylistItemId)).toBe(false)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      // …and the queue it doesn't belong to is left intact.
      await releaseFromNativeQueue("i-c" as PlaylistItemId)
      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b"])
    })

    it("defers the rewrite while paused, and keeps the file until it lands", async () => {
      const player = await playQueueFromA()
      pauseEngine()

      // setQueue starts playback, so rewriting a paused engine would resume
      // audio the user didn't ask for.
      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(true)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      await player.togglePause()

      expect(audioPlayer.togglePause).not.toHaveBeenCalled()
      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b"])
    })

    it("takes the engine's word on playback, not the last progress tick", async () => {
      await playQueueFromA()
      // The pause tap has landed on the engine; `playing.value` only follows on
      // the next progress tick, up to a second later.
      queueState = { ...queueState, playing: false }

      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(true)
      // Rewriting here would restart playback the user has just stopped.
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()
    })

    it("reclaims the deferred lecture's audio once the rewrite lands", async () => {
      const player = await playQueueFromA()
      pauseEngine()
      // The archive kept the file because the engine could still reach it, and
      // nothing else in the app ever collects it.
      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(true)
      expect(downloads.evict).not.toHaveBeenCalled()

      await player.togglePause()

      expect(downloads.evict).toHaveBeenCalledWith("t-c")
    })

    it("writes the debt down, so a kill in the window doesn't strand the file", async () => {
      await playQueueFromA()

      // Kept because the engine is on it. The in-memory set that remembers to
      // reclaim it dies with the process — the media row does not (issue #1666).
      expect(await releaseFromNativeQueue("i-a" as PlaylistItemId)).toBe(true)

      await vi.waitFor(() =>
        expect(downloads.markEvictPending).toHaveBeenCalledWith("t-a" as TrackId)
      )
    })

    it("reclaims what it kept when playback stops", async () => {
      const player = await playQueueFromA()

      expect(await releaseFromNativeQueue("i-a" as PlaylistItemId)).toBe(true)
      await player.stop()

      expect(downloads.evict).toHaveBeenCalledWith("t-a")
    })

    it("protects a queue the engine restored after a background kill", async () => {
      // Nothing opened this queue in THIS session — native rebuilt it from its
      // own journal, so the JS mirror `loadTrack` fills was never populated.
      const player = usePlayerStore()
      await vi.waitFor(() => expect(player.itemId).toBe("i-a"))
      audioPlayer.setQueue.mockClear()

      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(false)

      expect(audioPlayer.setQueue).toHaveBeenCalledTimes(1)
      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b"])
    })
  })

  describe("a track opened on its own", () => {
    /** Open A through the single-track `open()` path, play it, then come back
     *  from the background — the resync that used to arm queue mode. */
    async function openSingleTrackA(): Promise<ReturnType<typeof usePlayerStore>> {
      // Nothing loaded natively yet, so the startup drain can't adopt anything
      // before the open under test runs.
      queueState = { ...queueState, currentItemId: null, playing: false, queueCount: 0 }
      const player = usePlayerStore()
      await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
      // `open()` is natively a queue of length ONE.
      queueState = { ...queueState, currentItemId: "i-a", playing: true, queueCount: 1 }
      emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })
      await resumeForeground()
      return player
    }

    it("stays a single track for a non-subscriber when another lecture is archived", async () => {
      isSubscribed = false
      await openSingleTrackA()
      expect(audioPlayer.open).toHaveBeenCalled()
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      // This is where continuous playback used to appear out of nowhere: the
      // resync armed queue mode off the live native item, the mirror was
      // rebuilt from the whole playlist, and the archive pushed it into the
      // engine — auto-advance and lock-screen next/prev, unpaid for (#1775).
      activeItemIds.delete("i-c")

      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(false)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()
      expect(playlist.buildQueueFrom).not.toHaveBeenCalled()
    })

    it("honours a subscriber who turned auto-play-next off", async () => {
      autoPlayNext = false
      await openSingleTrackA()
      activeItemIds.delete("i-b")

      expect(await releaseFromNativeQueue("i-b" as PlaylistItemId)).toBe(false)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()
    })

    it("is not fabricated into a queue by a cold restore either", async () => {
      // Same cold-restore path as the real queue above — but the engine's
      // timeline holds exactly one item, so there is no queue to protect.
      queueState = { ...queueState, queueCount: 1 }
      const player = usePlayerStore()
      await vi.waitFor(() => expect(player.itemId).toBe("i-a"))
      audioPlayer.setQueue.mockClear()

      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(false)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()
    })
  })

  describe("the deferred rewrite", () => {
    it("does not swallow the resume tap when the mirror cannot place the item", async () => {
      const player = await playQueueFromA()
      pauseEngine()
      // Archived while paused: filtered out of the mirror, rewrite deferred.
      activeItemIds.delete("i-b")
      expect(await releaseFromNativeQueue("i-b" as PlaylistItemId)).toBe(true)

      // The engine still holds B and a lock-screen "next" advances onto it.
      queueState = { ...queueState, currentItemId: "i-b", positionMs: 0 }
      emitProgress({ itemId: "i-b", playing: false, position: 0, duration: 60_000 })
      await vi.waitFor(() => expect(player.itemId).toBe("i-b"))
      audioPlayer.togglePause.mockClear()

      await player.togglePause()
      await player.togglePause()

      // Without this the tap neither rewrites nor resumes — forever.
      expect(audioPlayer.togglePause).toHaveBeenCalledTimes(2)
    })
  })

  describe("advancing onto an item the active list no longer carries", () => {
    it("moves the player's identity instead of pinning it to the previous lecture", async () => {
      const player = await playQueueFromA()
      // Archived mid-playback: gone from `entries`, still in the native queue.
      activeItemIds.delete("i-c")
      queueState = { ...queueState, currentItemId: "i-c", positionMs: 0 }

      emitProgress({ itemId: "i-c", playing: true, position: 0, duration: 60_000 })
      await vi.waitFor(() => expect(player.itemId).toBe("i-c"))

      expect(player.trackId).toBe("t-c")
      expect(player.title).toBe("Lecture t-c")
      // The lecture we advanced away from was journaled, not silently dropped.
      expect(finishCurrent).toHaveBeenCalledWith("i-a", expect.any(Number))
    })

    it("lets go of an item nothing can name, rather than freezing on the old one", async () => {
      const player = await playQueueFromA()
      playlist.resolveTrackForItemId.mockResolvedValueOnce(undefined)
      queueState = { ...queueState, currentItemId: "i-gone", positionMs: 0 }

      emitProgress({ itemId: "i-gone", playing: true, position: 0, duration: 60_000 })
      await vi.waitFor(() => expect(player.itemId).toBeNull())

      // Pinned to "i-a", every later tick would fail the identity guard and a
      // pause tap would patch the wrong lecture's progress.
      expect(player.playing).toBe(false)
      expect(finishCurrent).toHaveBeenCalledWith("i-a", expect.any(Number))
    })
  })
})
