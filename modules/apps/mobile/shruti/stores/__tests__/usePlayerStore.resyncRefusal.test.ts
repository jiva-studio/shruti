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

/** `t-b` deliberately has NO audio on any variant — `playTrack` refuses it
 *  with `no-audio-available`, which is how a real queue reaches an item the
 *  player cannot name a plan for. */
function track(id: string, withAudio: boolean): Track {
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
        audio: withAudio
          ? {
              path: `public/tracks/${id}/audio/original.mp3`,
              filesize: 1,
              duration: 60_000,
              kind: "original",
            }
          : null,
        transcript: null,
        outline: null,
        description: null,
      },
    ],
  }
}

const TRACKS = new Map<string, Track>([
  ["t-a", track("t-a", true)],
  ["t-b", track("t-b", false)],
])

const QUEUE: AudioQueueItem[] = [
  { itemId: "i-a", url: "file:///a.mp3", title: "Lecture t-a", author: "" },
  { itemId: "i-b", url: "file:///b.mp3", title: "Lecture t-b", author: "" },
]

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

let progressListener: AudioProgressListener | null = null
let queueState: AudioQueueState = {
  currentItemId: "i-a",
  positionMs: 0,
  durationMs: 60_000,
  playing: true,
  queueCount: 3,
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
  setQueue: vi.fn(async () => {}),
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
])
const playlist = {
  buildQueueFrom: vi.fn(async (fromItemId: string) => {
    const start = QUEUE.findIndex((q) => q.itemId === fromItemId)
    return start < 0 ? [] : QUEUE.slice(start).map((q) => ({ ...q }))
  }),
  getEntryByItemId: (id: string) => ({
    item: { id, trackId: itemToTrack.get(id) },
    track: TRACKS.get(itemToTrack.get(id)!),
  }),
  resolveTrackForItemId: vi.fn(async (id: string) => TRACKS.get(itemToTrack.get(id) ?? "")),
  patchProgress: vi.fn(),
  getCompletedAt: () => null,
}
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({ usePlaylistStore: () => playlist }))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: true }),
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
vi.mock("@shruti/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ref(true),
}))
const finishCurrent = vi.fn(async () => {})
vi.mock("@shruti/stores/player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    flushOnHide: vi.fn(),
    finishCurrent,
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
vi.mock("@capacitor/app", () => ({ App: { addListener: async () => ({ remove: vi.fn() }) } }))

import { usePlayerStore } from "../usePlayerStore.js"

function emitProgress(status: AudioStatus): void {
  progressListener?.(status)
}

/** Drain the pending microtask/macrotask work the store kicked off. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/* --------------------------------------------------------------------- */

describe("usePlayerStore — the engine advances onto an unplayable item", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    progressListener = null
    queueState = {
      currentItemId: "i-a",
      positionMs: 7_000,
      durationMs: 60_000,
      playing: true,
      queueCount: 3,
      events: [],
    }
    playlist.resolveTrackForItemId.mockClear()
    finishCurrent.mockClear()
  })

  it("releases the player's identity instead of pinning it to the previous lecture", async () => {
    const player = usePlayerStore()
    await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
    // Let the startup native-state drain settle: it holds the single-flight
    // `syncing` guard, and an advance raised while it runs is simply dropped.
    await settle()
    playlist.resolveTrackForItemId.mockClear()
    emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })
    expect(player.itemId).toBe("i-a")

    // Native auto-advanced onto B, whose track has no playable audio — the
    // play plan is refused. Nothing here can be shown or journaled.
    queueState = { ...queueState, currentItemId: "i-b", positionMs: 0 }
    emitProgress({ itemId: "i-b", playing: true, position: 0, duration: 60_000 })
    await vi.waitFor(() => expect(playlist.resolveTrackForItemId).toHaveBeenCalledWith("i-b"))
    await vi.waitFor(() => expect(player.playing).toBe(false))

    // Pinned to "i-a", every later tick fails the identity guard, re-enters
    // `syncFromNative` forever, the FloatingPlayer names the wrong lecture and
    // a pause tap patches the wrong item's position. The identity has to go.
    expect(player.itemId).toBeNull()
  })

  it("does not re-enter the native drain on every subsequent tick", async () => {
    const player = usePlayerStore()
    await player.openTrack({ track: TRACKS.get("t-a")!, itemId: "i-a" as PlaylistItemId })
    // Let the startup native-state drain settle: it holds the single-flight
    // `syncing` guard, and an advance raised while it runs is simply dropped.
    await settle()
    playlist.resolveTrackForItemId.mockClear()
    emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })

    queueState = { ...queueState, currentItemId: "i-b", positionMs: 0, playing: false }
    emitProgress({ itemId: "i-b", playing: true, position: 0, duration: 60_000 })
    await vi.waitFor(() => expect(player.itemId).toBeNull())

    // With the identity released the progress guard drops later events for the
    // unplayable item outright — no playlist read, no `playTrack`, per tick.
    playlist.resolveTrackForItemId.mockClear()
    emitProgress({ itemId: "i-b", playing: true, position: 1_000, duration: 60_000 })
    emitProgress({ itemId: "i-b", playing: true, position: 2_000, duration: 60_000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(playlist.resolveTrackForItemId).not.toHaveBeenCalled()
  })
})
