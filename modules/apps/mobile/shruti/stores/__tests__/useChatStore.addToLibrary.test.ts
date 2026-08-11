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

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
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

vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({
    get isSubscribed() {
      return isSubscribedRef.value
    },
  }),
}))
vi.mock("@shruti/stores/usePaywallStore.js", () => ({
  usePaywallStore: () => ({ requestOpen }),
}))
vi.mock("@shruti/services/syncEvents.js", () => ({
  requestSync: (...args: unknown[]) => requestSync(...args),
}))

// Chat is discovery only now — a candidate confirm delegates to the library
// store's ingest-API path (which owns the PRO gate + paywall), never a chat turn.
const addByUrl = vi.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue("added")
vi.mock("@shruti/stores/useLibraryStore.js", () => ({
  useLibraryStore: () => ({ addByUrl }),
}))

vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn().mockResolvedValue({ ok: true }) }),
}))
vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ quotaId: "", isPro: false, ensureFresh: vi.fn() }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({
  useAppLanguage: () => ({ value: "en" }),
}))
vi.mock("@shruti/composables/useChatLanguage.js", () => ({
  useChatLanguage: () => ({ value: "" }),
  useChatTranslateCitations: () => ({ value: false }),
}))
vi.mock("@shruti/composables/useTrackUserState.js", () => ({
  useTrackUserState: () => ({ buildUserContext: vi.fn() }),
}))
vi.mock("@shruti/composables/useDailyReminder.js", () => ({
  applyDailyReminder: vi.fn(),
}))
vi.mock("@lib/chat/chatMarkers.js", () => ({
  extractFollowups: () => [],
  parseChatMarkers: () => [],
}))
vi.mock("@shruti/utils/openStorePage.js", () => ({
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

function actionState(store: ReturnType<typeof useChatStore>): string | undefined {
  return store.messages[0]?.actionStates?.a1
}

describe("useChatStore.executeAction — add_to_library candidate", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    isSubscribedRef.value = false
    requestOpen.mockClear()
    requestSync.mockClear()
    runChatTurn.mockClear()
    updateActionStates.mockClear()
    addByUrl.mockClear().mockResolvedValue("added")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("delegates the candidate to the library store's ingest-API path, never a chat turn", async () => {
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    // Chat does NOT ingest: the URL is handed to the library store (which owns
    // the PRO gate + the ingest-API submit), and no chat turn is dispatched.
    expect(addByUrl).toHaveBeenCalledTimes(1)
    expect(addByUrl.mock.calls[0]?.[0]).toBe(CANDIDATE_URL)
    expect(runChatTurn).not.toHaveBeenCalled()
  })

  it("marks the action done once the submit really happened", async () => {
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    expect(actionState(store)).toBe("done")
  })

  // #1727: the PRO gate is the DESIGNED path for a non-subscriber — it opens
  // the paywall and returns without submitting anything. A `done` here is the
  // bug: the tile drops its Add control for a lecture that was never fetched,
  // and the state is persisted, so it survives a restart.
  it("leaves the card confirmable when the PRO gate bounced the user to the paywall", async () => {
    addByUrl.mockResolvedValue("paywalled")
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    expect(actionState(store)).not.toBe("done")
    expect(actionState(store)).toBe("pending")
    // …and back at "pending" the guard lets a second tap through, so a user who
    // subscribes can act on the same card.
    addByUrl.mockResolvedValue("added")
    await store.executeAction("m1", "a1")
    expect(addByUrl).toHaveBeenCalledTimes(2)
    expect(actionState(store)).toBe("done")
  })

  it("marks a refused submit as an error, which the card renders as a retry", async () => {
    addByUrl.mockResolvedValue("failed")
    const store = seedAddToLibraryAction()

    await store.executeAction("m1", "a1")

    expect(actionState(store)).toBe("error")
  })
})
