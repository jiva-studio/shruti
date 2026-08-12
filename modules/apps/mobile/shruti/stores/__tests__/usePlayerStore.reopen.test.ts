import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { AudioProgressListener, AudioQueueState, AudioStatus } from "@ports/app/audioPlayer.js"

/**
 * Re-opening the lecture that is ALREADY loaded takes the `sameItem` fast path
 * in `loadTrack`, which deliberately skips the reload so the engine position
 * survives. It skipped two things it should not have:
 *
 *  - a position the caller explicitly asked for (`resumeFromMs`, produced by
 *    the chat outline card's chapter rows) — the app navigated and playback
 *    simply carried on (#1794);
 *  - the question of whether the engine still HAS the item. On iOS the last
 *    item of a queue leaves the player alive with nothing loaded, so `play()`
 *    is a no-op and replaying a lecture that just finished was a dead tap
 *    (#1793).
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

const TRACK = track("t-a")
const ITEM = "i-a" as PlaylistItemId

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

let progressListener: AudioProgressListener | null = null
let queueState: AudioQueueState = {
  currentItemId: "i-a",
  positionMs: 0,
  durationMs: 60_000,
  playing: false,
  queueCount: 1,
  events: [],
}

const audioPlayer = {
  open: vi.fn(async () => {}),
  play: vi.fn(async () => {}),
  togglePause: vi.fn(async () => {}),
  seek: vi.fn<(ms: number) => Promise<void>>(async () => {}),
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

vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    buildQueueFrom: vi.fn(async () => []),
    getEntryByItemId: () => ({ item: { id: "i-a", trackId: "t-a" }, track: TRACK }),
    resolveTrackForItemId: vi.fn(async () => TRACK),
    patchProgress: vi.fn(),
    getCompletedAt: () => null,
  }),
}))
// Single-track path: the queue path has its own coverage and would only add
// noise to what these tests are about.
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: false }),
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
  useAutoPlayNext: () => ref(false),
}))

const finishCurrent = vi.fn(async () => {})
const recordSeek = vi.fn(async () => {})
vi.mock("@shruti/stores/player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    flushOnHide: vi.fn(),
    finishCurrent,
    recordSeek,
    hasActive: () => false,
    activeItemId: () => null,
  }),
}))
// The real resolver's contract, kept to what these tests exercise: an explicit
// `resumeFromMs` wins, anything else starts from the beginning (a finished
// lecture's saved position clamps to 0 there too).
vi.mock("@shruti/stores/player/usePlayerResumePosition.js", () => ({
  usePlayerResumePosition: () => ({
    resolve: async (input: { resumeFromMs?: number | null }) =>
      input.resumeFromMs === undefined ? 0 : Math.max(0, input.resumeFromMs ?? 0),
  }),
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

/* --------------------------------------------------------------------- */
/*                               Helpers                                 */
/* --------------------------------------------------------------------- */

function emitProgress(status: AudioStatus): void {
  progressListener?.(status)
}

/** Open the lecture and let it play a little, the way a row tap does. */
async function playIt(): Promise<ReturnType<typeof usePlayerStore>> {
  const player = usePlayerStore()
  await player.openTrack({ track: TRACK, itemId: ITEM })
  emitProgress({ itemId: "i-a", playing: true, position: 5_000, duration: 60_000 })
  for (const fn of Object.values(audioPlayer)) {
    if (typeof fn === "function" && "mockClear" in fn) fn.mockClear()
  }
  return player
}

describe("usePlayerStore — re-opening the lecture already loaded", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    progressListener = null
    queueState = {
      currentItemId: "i-a",
      positionMs: 5_000,
      durationMs: 60_000,
      playing: true,
      queueCount: 1,
      events: [],
    }
    finishCurrent.mockClear()
    recordSeek.mockClear()
    for (const fn of Object.values(audioPlayer)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear()
    }
  })

  it("seeks to a position the caller asked for instead of dropping it", async () => {
    const player = await playIt()

    // What a chapter row of the chat outline card produces for the lecture
    // that happens to be playing already (#1794).
    await player.openTrack({ track: TRACK, itemId: ITEM, resumeFromMs: 30_000 })

    expect(audioPlayer.seek).toHaveBeenCalledWith(30_000)
    // Still the fast path: the audio is not reloaded and the session is not
    // closed out, only the position moves.
    expect(audioPlayer.open).not.toHaveBeenCalled()
    expect(finishCurrent).not.toHaveBeenCalled()
    expect(player.positionMs).toBe(30_000)
    // The jump is journaled, so the skipped span isn't counted as listened.
    expect(recordSeek).toHaveBeenCalled()
  })

  it("leaves the position alone when the caller asked for no particular one", async () => {
    const player = await playIt()

    await player.openTrack({ track: TRACK, itemId: ITEM })

    expect(audioPlayer.seek).not.toHaveBeenCalled()
    expect(audioPlayer.open).not.toHaveBeenCalled()
    expect(player.positionMs).toBe(5_000)
  })

  it("resumes a paused lecture without reloading it", async () => {
    const player = await playIt()
    queueState = { ...queueState, playing: false }
    emitProgress({ itemId: "i-a", playing: false, position: 5_000, duration: 60_000 })
    audioPlayer.play.mockClear()

    await player.openTrack({ track: TRACK, itemId: ITEM })

    expect(audioPlayer.play).toHaveBeenCalled()
    expect(audioPlayer.open).not.toHaveBeenCalled()
  })

  it("reloads when the engine no longer holds the item, so a finished lecture replays", async () => {
    const player = await playIt()
    // The queue ran dry. iOS keeps the player alive with no current item, and
    // `play()` on it does nothing — our identity still names the lecture, so
    // without this check the tap took the fast path into that dead call (#1793).
    queueState = { ...queueState, currentItemId: null, playing: false }

    await player.openTrack({ track: TRACK, itemId: ITEM })

    expect(audioPlayer.open).toHaveBeenCalledWith(expect.objectContaining({ itemId: "i-a" }))
    expect(audioPlayer.play).toHaveBeenCalled()
    // Reloaded from the top, not from the credits, and the finished session
    // was closed out on the way through.
    expect(player.positionMs).toBe(0)
    expect(finishCurrent).toHaveBeenCalledWith("i-a", expect.any(Number))
    expect(player.itemId).toBe("i-a")
  })

  it("keeps the fast path when the engine cannot be asked", async () => {
    const player = await playIt()
    audioPlayer.getQueueState.mockRejectedValueOnce(new Error("bridge down"))

    await player.openTrack({ track: TRACK, itemId: ITEM })

    // A bridge failure says nothing about the engine — reloading on it would
    // restart audio that is very probably still loaded.
    expect(audioPlayer.open).not.toHaveBeenCalled()
  })
})
