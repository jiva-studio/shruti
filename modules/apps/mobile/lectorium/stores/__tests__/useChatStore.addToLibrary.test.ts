import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

// Subscription state the PRO gate reads — flipped per test.
const isSubscribedRef = { value: false }
const requestOpen = vi.fn()
const requestSync = vi.fn()

// The client→server dispatch: `applyAddToLibrary` reaches it through
// `sendMessage`. An empty async generator lets sendMessage run to completion
// without exercising the streaming machinery.
const runChatTurn = vi.fn<(...args: unknown[]) => AsyncGenerator<never>>(() =>
  (async function* () {})()
)

const updateActionStates = vi.fn().mockResolvedValue(undefined)
const createSession = vi
  .fn()
  .mockImplementation(({ id, title }: { id: string; title: string }) =>
    Promise.resolve({ id, title, updatedAt: 0 })
  )

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      chatSessions: { create: createSession },
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

vi.mock("@lectorium/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    get isSubscribed() {
      return isSubscribedRef.value
    },
  }),
}))
vi.mock("@lectorium/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen }),
}))
vi.mock("@lectorium/services/syncEvents.js", () => ({
  requestSync: (...args: unknown[]) => requestSync(...args),
}))

vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn().mockResolvedValue({ ok: true }) }),
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
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"

/* --------------------------------------------------------------------- */
/*                                Tests                                   */
/* --------------------------------------------------------------------- */

const CANDIDATE_URL = "https://youtu.be/abc123"

function seedAddToLibraryAction() {
  const store = useChatStore()
  store.messages = [
    {
      id: "m1" as ChatMessageId,
      sessionId: "s1" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 0,
      actions: {
        a1: {
          kind: "add_to_library",
          id: "a1",
          url: CANDIDATE_URL,
          title: "A lecture online",
          author: "Someone",
          thumbnail: null,
        },
      },
    },
  ]
  return store
}

describe("useChatStore.executeAction — add_to_library candidate", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isSubscribedRef.value = false
    requestOpen.mockClear()
    requestSync.mockClear()
    runChatTurn.mockClear()
    updateActionStates.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("PRO-gates: a non-subscriber is bounced to the paywall, no ingest", async () => {
    isSubscribedRef.value = false
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    expect(requestOpen).toHaveBeenCalledTimes(1)
    // No client→server dispatch and no poller nudge for a gated user.
    expect(runChatTurn).not.toHaveBeenCalled()
    expect(requestSync).not.toHaveBeenCalled()
  })

  it("subscriber: dispatches the ingest turn with the URL and nudges the poller", async () => {
    isSubscribedRef.value = true
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    expect(requestOpen).not.toHaveBeenCalled()
    // The client→server call carried the candidate URL as the turn text.
    expect(runChatTurn).toHaveBeenCalledTimes(1)
    const input = runChatTurn.mock.calls[0]?.[0] as { text: string }
    expect(input.text).toBe(CANDIDATE_URL)
    // Poller nudged so the freshly-queued item surfaces on the short cadence.
    expect(requestSync).toHaveBeenCalledTimes(1)
  })
})
