import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type { AppLifecycleSubscription } from "@ports/app/index.js"
import type { AudioQueueState } from "@ports/app/audioPlayer.js"

const IDLE: AudioQueueState = {
  currentItemId: null,
  positionMs: 0,
  durationMs: 0,
  playing: false,
  queueCount: 0,
  events: [],
}

const ctx = vi.hoisted(() => ({
  onStateChange: null as unknown as ReturnType<
    typeof vi.fn<() => Promise<AppLifecycleSubscription>>
  >,
  reportError: null as unknown as ReturnType<typeof vi.fn<(...args: unknown[]) => void>>,
}))

const audioPlayer = {
  setMix: vi.fn(async () => {}),
  setPlaybackRate: vi.fn(async () => {}),
  getQueueState: vi.fn(async () => IDLE),
  ackEvents: vi.fn(async () => {}),
  onProgress: () => () => {},
  onTransition: () => () => {},
  onPositionJump: () => () => {},
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    audioPlayer,
    repositories: () => ({}),
    appLifecycle: { onStateChange: ctx.onStateChange },
  }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    buildQueueFrom: vi.fn(async () => []),
    resolveTrackForItemId: vi.fn(async () => undefined),
    patchProgress: vi.fn(),
    getCompletedAt: () => null,
  }),
}))
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
  useAutoPlayNext: () => ref(true),
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
vi.mock("@shruti/wiring/queueJournal.js", () => ({
  useQueueJournalReconciler: () => ({ reconcileAndAck: vi.fn(async () => {}) }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: (...args: unknown[]) => ctx.reportError(...args),
}))
vi.mock("@lib/chat/audio/useAudioOrchestrator.js", () => ({
  registerAudioSource: () => ({ claim: vi.fn(), release: vi.fn() }),
}))
vi.mock("@shruti/i18n/index.js", () => ({ i18n: { global: { t: (k: string) => k } } }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))

import { usePlayerStore } from "../usePlayerStore.js"

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let handle: AppLifecycleSubscription & { remove: ReturnType<typeof vi.fn> }

beforeEach(() => {
  setActivePinia(createPinia())
  handle = { remove: vi.fn(async () => {}) }
  ctx.onStateChange = vi.fn(async () => handle)
  ctx.reportError = vi.fn()
})

describe("usePlayerStore — the foreground listener's lifetime", () => {
  it("keeps the listener while the store lives and removes it on dispose", async () => {
    const player = usePlayerStore()
    await settle()
    expect(handle.remove).not.toHaveBeenCalled()

    player.$dispose()
    await settle()

    expect(handle.remove).toHaveBeenCalledOnce()
  })

  it("reports a listener that fails to register", async () => {
    const boom = new Error("bridge gone")
    ctx.onStateChange.mockRejectedValueOnce(boom)
    const player = usePlayerStore()
    await settle()

    expect(ctx.reportError).toHaveBeenCalledWith("player", boom)
    player.$dispose()
  })

  it("removes a listener that registers after the store is disposed", async () => {
    let register!: (h: AppLifecycleSubscription) => void
    ctx.onStateChange.mockImplementationOnce(
      () => new Promise<AppLifecycleSubscription>((resolve) => (register = resolve))
    )
    const player = usePlayerStore()
    player.$dispose()

    register(handle)
    await settle()

    expect(handle.remove).toHaveBeenCalledOnce()
  })

  it("reports a listener that fails to detach", async () => {
    const boom = new Error("bridge gone")
    handle.remove.mockRejectedValueOnce(boom)
    const player = usePlayerStore()
    await settle()

    player.$dispose()
    await settle()

    expect(ctx.reportError).toHaveBeenCalledWith("player", boom)
  })
})
