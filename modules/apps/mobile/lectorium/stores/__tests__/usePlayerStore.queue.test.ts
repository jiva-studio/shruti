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
let queueState: AudioQueueState = {
  currentItemId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
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
  buildQueueFrom: vi.fn(async () => QUEUE.map((q) => ({ ...q }))),
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
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true }),
}))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: null, show: vi.fn() }),
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({
    markPending: vi.fn(),
    clearPending: vi.fn(),
    ensureDownloaded: async () => "file:///a.mp3",
  }),
}))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (_key: string, initial: unknown) => ref(initial),
}))
vi.mock("@lectorium/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ref(true),
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
vi.mock("@capacitor/app", () => ({ App: { addListener: async () => ({ remove: vi.fn() }) } }))

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

describe("usePlayerStore — the live native queue", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    activeItemIds = new Set(["i-a", "i-b", "i-c"])
    queueState = {
      currentItemId: "i-a",
      positionMs: 7_000,
      durationMs: 60_000,
      playing: true,
      events: [],
    }
    progressListener = null
    finishCurrent.mockClear()
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

    it("leaves the engine alone for an item behind the playhead", async () => {
      const player = await playQueueFromA()
      queueState = { ...queueState, currentItemId: "i-b", positionMs: 1_000 }
      await player.playNext()
      emitProgress({ itemId: "i-b", playing: true, position: 1_000, duration: 60_000 })
      audioPlayer.setQueue.mockClear()

      // The auto-archive sweep archives FINISHED lectures mid-playback; a
      // rewrite for those would restart the current one every time.
      expect(await releaseFromNativeQueue("i-a" as PlaylistItemId)).toBe(false)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      // It is still dropped, so the next rewrite doesn't put it back.
      await releaseFromNativeQueue("i-c" as PlaylistItemId)
      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-b"])
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
      emitProgress({ itemId: "i-a", playing: false, position: 7_000, duration: 60_000 })

      // setQueue starts playback, so rewriting a paused engine would resume
      // audio the user didn't ask for.
      expect(await releaseFromNativeQueue("i-c" as PlaylistItemId)).toBe(true)
      expect(audioPlayer.setQueue).not.toHaveBeenCalled()

      await player.togglePause()

      expect(audioPlayer.togglePause).not.toHaveBeenCalled()
      const [items] = audioPlayer.setQueue.mock.calls[0]!
      expect(items.map((q) => q.itemId)).toEqual(["i-a", "i-b"])
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
