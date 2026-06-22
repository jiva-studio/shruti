import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

// playlist.add is the side effect we must guard against double-firing.
const playlistAdd = vi.fn().mockResolvedValue({ ok: true })

// A controllable updateActionStates: each call returns a promise we can
// resolve on demand, so we can hold the first executeAction mid-await
// (right after it flipped to "executing") and fire a second tap into the
// window the synchronous guard must close.
let pendingActionStateResolvers: Array<() => void> = []
const updateActionStates = vi.fn().mockImplementation(
  () =>
    new Promise<void>((resolve) => {
      pendingActionStateResolvers.push(resolve)
    })
)

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      chatSessions: {},
      chatMessages: { updateActionStates },
      proactiveState: {},
    }),
    chatStreamClient: {},
    chatTitleService: {},
    chatQuestionsService: {},
    chatFeedbackService: {},
    preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    notifications: {},
  }),
}))

vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: playlistAdd }),
}))

vi.mock("@lectorium/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ quotaId: "", isPro: false, ensureFresh: vi.fn() }),
}))

vi.mock("@lectorium/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "en" }),
}))
vi.mock("@lectorium/composables/useChatLanguage.js", () => ({
  useChatLanguage: () => ({ value: "" }),
  useChatTranslateCitations: () => ({ value: false }),
}))
vi.mock("@lectorium/composables/useTrackUserState.js", () => ({
  useTrackUserState: () => ({ buildUserContext: vi.fn() }),
}))
vi.mock("@lectorium/composables/useDailyReminder.js", () => ({
  applyDailyReminder: vi.fn(),
}))
vi.mock("@lib/chat/chatMarkers.js", () => ({
  extractFollowups: () => [],
  parseChatMarkers: () => [],
}))
vi.mock("@lectorium/utils/openStorePage.js", () => ({
  openStorePage: vi.fn(),
}))

vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))
vi.mock("@ionic/vue", () => ({
  toastController: { create: vi.fn() },
}))
vi.mock("@usecases", () => ({
  runChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"

/* --------------------------------------------------------------------- */
/*                                Tests                                   */
/* --------------------------------------------------------------------- */

describe("useChatStore.executeAction — double-tap guard (finding #15)", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    playlistAdd.mockClear().mockResolvedValue({ ok: true })
    updateActionStates.mockClear()
    pendingActionStateResolvers = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function seedQueueAction() {
    const store = useChatStore()
    store.messages = [
      {
        id: "m1" as ChatMessageId,
        sessionId: "s1" as ChatSessionId,
        role: "assistant",
        content: "",
        createdAt: 0,
        actions: {
          a1: { kind: "queue_next_track", id: "a1", trackId: "t-99" },
        },
      },
    ]
    return store
  }

  it("fires the side effect exactly once for two rapid confirm taps", async () => {
    const store = seedQueueAction()

    // Two taps with NO await in between. The second is rejected without
    // ever reaching the repo — caught by the synchronous in-flight guard
    // (belt) and, redundantly, by the in-memory "executing" flip that
    // `setActionState` performs before its await (suspenders). Either way
    // only the first call's "executing" write is in flight.
    const first = store.executeAction("m1", "a1")
    const second = store.executeAction("m1", "a1")
    expect(updateActionStates).toHaveBeenCalledTimes(1)

    // Drain the deferred writes: resolving "executing" lets the side
    // effect + the "done" write land, which pushes a fresh resolver.
    // Poll a bounded number of microtask rounds so we don't spin forever
    // if the chain ever changes shape.
    for (let round = 0; round < 20; round++) {
      while (pendingActionStateResolvers.length > 0) {
        pendingActionStateResolvers.shift()!()
      }
      // Flush microtasks so the next setActionState await can run and
      // enqueue its resolver.
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all([first, second])

    // The whole point: playlist.add ran once, not twice.
    expect(playlistAdd).toHaveBeenCalledTimes(1)
    expect(playlistAdd).toHaveBeenCalledWith("t-99")
  })

  it("rejects a re-tap once the action is already done", async () => {
    const store = seedQueueAction()
    // Pre-mark as done.
    store.messages = [{ ...store.messages[0], actionStates: { a1: "done" } }]
    await store.executeAction("m1", "a1")
    expect(playlistAdd).not.toHaveBeenCalled()
  })
})
