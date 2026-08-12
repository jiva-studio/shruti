import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { AudioPositionJumpListener } from "@ports/app/audioPlayer.js"

/**
 * Every position jump must reach the listening journal. `seek()` always did;
 * the ±15 s buttons and every jump the system made on its own (lock-screen
 * scrub, remote ±15 s) did not, so the next progress tick simply raised
 * `to_position` over the skipped span and the day's total counted audio nobody
 * heard (#1623).
 */

const recordSeek = vi.fn().mockResolvedValue(undefined)
const seekBy = vi.fn().mockResolvedValue(undefined)
/** The store's handler for engine-initiated jumps, captured at subscribe. */
let jumpListener: AudioPositionJumpListener | null = null

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({}),
    preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    audioPlayer: {
      onProgress: () => () => undefined,
      onTransition: () => () => undefined,
      onPositionJump: (listener: AudioPositionJumpListener) => {
        jumpListener = listener
        return () => undefined
      },
      getQueueState: async () => ({
        currentItemId: null,
        positionMs: 0,
        durationMs: 0,
        playing: false,
        queueCount: 0,
        events: [],
      }),
      seekBy,
      seek: vi.fn().mockResolvedValue(undefined),
      setMix: vi.fn().mockResolvedValue(undefined),
      setPlaybackRate: vi.fn().mockResolvedValue(undefined),
    },
  }),
}))

vi.mock("@lectorium/stores/player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    flushOnHide: vi.fn(),
    finishCurrent: vi.fn().mockResolvedValue(undefined),
    recordSeek,
    hasActive: () => false,
    activeItemId: () => null,
  }),
}))
vi.mock("@lectorium/stores/player/usePlayerQueueReconcile.js", () => ({
  usePlayerQueueReconcile: () => ({ reconcileAndAck: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock("@lectorium/stores/player/usePlayerResumePosition.js", () => ({
  usePlayerResumePosition: () => ({ resolve: vi.fn() }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    patchProgress: vi.fn(),
    getEntryByItemId: () => null,
    getCompletedAt: () => null,
  }),
}))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: null, show: vi.fn() }),
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({}),
}))
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isPro: false }),
}))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (_key: string, fallback: unknown) => ref(fallback),
}))
vi.mock("@lectorium/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ({ enabled: ref(false) }),
}))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  registerAudioSource: () => ({ claim: vi.fn(), release: vi.fn() }),
}))
vi.mock("@usecases/playback/playTrack.js", () => ({ playTrack: vi.fn() }))
vi.mock("@lectorium/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))

import { usePlayerStore } from "../usePlayerStore.js"

/** A lecture open at 10:00, playing. */
function openPlayer() {
  const store = usePlayerStore()
  store.trackId = "track-1" as never
  store.itemId = "pi-1" as never
  store.durationMs = 3_600_000
  store.positionMs = 600_000
  store.playing = true
  return store
}

describe("usePlayerStore — position jumps reach the listening journal", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    recordSeek.mockClear()
    seekBy.mockClear()
    jumpListener = null
  })

  it("journals the +15s skip instead of letting the next tick absorb it", async () => {
    const store = openPlayer()

    await store.skipForward()

    expect(seekBy).toHaveBeenCalledWith(15000)
    expect(recordSeek).toHaveBeenCalledWith({
      itemId: "pi-1",
      positionBeforeMs: 600_000,
      positionAfterMs: 615_000,
      willKeepPlaying: true,
    })
  })

  it("journals the -15s skip as a discontinuity too", async () => {
    const store = openPlayer()

    await store.skipBack()

    expect(seekBy).toHaveBeenCalledWith(-15000)
    expect(recordSeek).toHaveBeenCalledWith({
      itemId: "pi-1",
      positionBeforeMs: 600_000,
      positionAfterMs: 585_000,
      willKeepPlaying: true,
    })
  })

  it("journals a jump the engine made on its own (lock-screen scrub)", async () => {
    const store = openPlayer()
    store.positionMs = 300_000
    expect(jumpListener).not.toBeNull()

    // Dragged from 5:00 to 45:00 on the lock screen — JS issued nothing, so
    // nothing else can journal it.
    jumpListener!({ itemId: "pi-1", fromMs: 300_000, toMs: 2_700_000 })
    await Promise.resolve()

    expect(store.positionMs).toBe(2_700_000)
    expect(recordSeek).toHaveBeenCalledWith({
      itemId: "pi-1",
      positionBeforeMs: 300_000,
      positionAfterMs: 2_700_000,
      willKeepPlaying: true,
    })

    // A jump on an item we are not mirroring is not ours to journal.
    recordSeek.mockClear()
    jumpListener!({ itemId: "pi-other", fromMs: 0, toMs: 1000 })
    await Promise.resolve()
    expect(recordSeek).not.toHaveBeenCalled()
  })
})
