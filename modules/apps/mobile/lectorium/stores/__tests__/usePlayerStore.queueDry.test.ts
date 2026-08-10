import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { AudioQueueState, AudioTransitionListener } from "@ports/app/audioPlayer.js"

/**
 * The store's defence for a native queue that ends up with no current item
 * (#1626). Before the fix the reset was gated on `queueActive`, which the
 * single-track path never sets — leaving `playing` stuck true, which turns
 * every tap on that row into a no-op via the `sameItem` short-circuit.
 */

const queueState: AudioQueueState = {
  currentItemId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  events: [],
}

let transitionListener: AudioTransitionListener | null = null

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
  onProgress: vi.fn(() => () => {}),
  setQueue: vi.fn(async () => {}),
  appendToQueue: vi.fn(async () => {}),
  getQueueState: vi.fn(async () => ({ ...queueState })),
  ackEvents: vi.fn(async () => {}),
  skipToNext: vi.fn(async () => {}),
  skipToPrevious: vi.fn(async () => {}),
  onTransition: vi.fn((listener: AudioTransitionListener) => {
    transitionListener = listener
    return () => {}
  }),
}

vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ({ audioPlayer }) }))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock("@capacitor/app", () => ({ App: { addListener: async () => ({ remove: () => {} }) } }))
vi.mock("@lectorium/services/monitoring/reportError.js", () => ({ reportError: vi.fn() }))
vi.mock("@usecases/playback/playTrack.js", () => ({ playTrack: vi.fn() }))
vi.mock("@lectorium/stores/useTranscriptStore.js", () => ({
  useTranscriptStore: () => ({ trackId: null, show: vi.fn() }),
}))
vi.mock("@lectorium/stores/useDownloadStore.js", () => ({
  useDownloadStore: () => ({
    markPending: vi.fn(),
    clearPending: vi.fn(),
    ensureDownloaded: vi.fn(async () => null),
  }),
}))
vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    patchProgress: vi.fn(),
    getEntryByItemId: () => undefined,
    buildQueueFrom: vi.fn(async () => []),
  }),
}))
vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ isSubscribed: false }),
}))
vi.mock("@lectorium/composables/useConfig.js", () => ({
  useConfig: (_key: string, fallback: unknown) => ref(fallback),
}))
vi.mock("@lectorium/composables/useAutoPlayNext.js", () => ({
  useAutoPlayNext: () => ref(false),
}))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  registerAudioSource: () => ({ claim: vi.fn(), release: vi.fn() }),
}))
vi.mock("../player/usePlayerSession.js", () => ({
  usePlayerSession: () => ({
    applyStatus: vi.fn(),
    finishCurrent: vi.fn(async () => {}),
    recordSeek: vi.fn(async () => {}),
    flushOnHide: vi.fn(),
  }),
}))
vi.mock("../player/usePlayerResumePosition.js", () => ({
  usePlayerResumePosition: () => ({ resolve: vi.fn(async () => 0) }),
}))
vi.mock("../player/usePlayerQueueReconcile.js", () => ({
  usePlayerQueueReconcile: () => ({ reconcileAndAck: vi.fn(async () => {}) }),
}))

import { usePlayerStore } from "../usePlayerStore.js"

/** Let the store's async native drain settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("usePlayerStore — native queue with no current item", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    transitionListener = null
    queueState.currentItemId = null
    queueState.playing = false
    queueState.events = []
  })

  it("clears a stale playing flag on the single-track path", async () => {
    const store = usePlayerStore()
    await settle()

    store.playing = true
    transitionListener?.({} as never)
    await settle()

    expect(store.playing).toBe(false)
  })

  it("leaves playing alone while the engine still reports playback", async () => {
    queueState.playing = true
    const store = usePlayerStore()
    await settle()

    store.playing = true
    transitionListener?.({} as never)
    await settle()

    expect(store.playing).toBe(true)
  })
})
