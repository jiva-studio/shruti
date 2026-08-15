import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/**
 * Issue #1837: `retryLast` drops the user prompt and the assistant reply from
 * SQLite — and, with chat sync on, tombstones both to the user's other devices
 * — BEFORE calling `sendMessage`, which returns on its first line while the
 * quota lock is armed. The tap therefore erased a question everywhere and
 * started nothing, with nothing on screen to say so.
 *
 * The reachable path is a `truncated` tail: it survives a reload, so a turn
 * that dropped mid-prose becomes the last bubble again after the 429 bubble is
 * dropped on re-read, while the lock — which lives on the store, not the view
 * — is still armed.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const deleteMessage = vi.fn().mockResolvedValue(undefined)

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      chatSessions: { touch: vi.fn(), create: vi.fn() },
      chatMessages: { delete: deleteMessage, listBySession: vi.fn().mockResolvedValue([]) },
      proactiveState: {},
    }),
    chatStreamClient: {},
    chatTitleService: {},
    chatQuestionsService: {},
    chatFeedbackService: {},
    chatResumeService: { getTurn: vi.fn(), cancelTurn: vi.fn() },
    preferences: {
      get: (k: string) => Promise.resolve(prefs.get(k) ?? null),
      set: (k: string, v: string) => Promise.resolve(void prefs.set(k, v)),
      remove: (k: string) => Promise.resolve(void prefs.delete(k)),
    },
    notifications: {},
  }),
}))

vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn() }),
}))
const authState = { quotaId: "q1", isPro: false, signedIn: false, ensureFresh: vi.fn() }
vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => authState,
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
vi.mock("@shruti/utils/openStorePage.js", () => ({ openStorePage: vi.fn() }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({ toastController: { create: vi.fn() } }))

const runChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

function userBubble(id: string, content: string): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "user",
    content,
    createdAt: 1,
  }
}

/** The tail a stream that died mid-prose leaves behind — and, unlike a
 *  `failed` bubble, one that survives a reload. */
function truncatedBubble(id: string): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content: "The soul is",
    createdAt: 2,
    error: { kind: "truncated", reason: "stream" } as ChatMessage["error"],
  }
}

/** The bubble a quota 429 leaves behind: empty prose, all meaning in `error`. */
function quotaBubble(id: string): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content: "",
    createdAt: 2,
    error: { kind: "failed", code: "rate_limited", tier: "anonymous" } as ChatMessage["error"],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  authState.quotaId = "q1"
  authState.isPro = false
  authState.signedIn = false
  deleteMessage.mockClear().mockResolvedValue(undefined)
  runChatTurn.mockReset().mockImplementation((input: { text: string }) =>
    (async function* () {
      yield { kind: "user-message", message: userBubble("u-new", input.text) }
    })()
  )
})

describe("useChatStore.retryLast — the armed quota lock (issue #1837)", () => {
  it("deletes nothing when the composer is locked", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "What is the soul?"), truncatedBubble("a1")]
    store.composeBlockedUntil = Date.now() + 60_000

    await store.retryLast("a1")

    // The whole defect: two deletes land, each one a sync-journal tombstone
    // that erases the question on the user's other devices, and `sendMessage`
    // then returns on its first line without starting anything.
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(runChatTurn).not.toHaveBeenCalled()
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1"])
  })

  it("retries normally once the deadline has passed", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "What is the soul?"), truncatedBubble("a1")]
    // A deadline in the past is not a lock — `isComposeBlocked` is a
    // clock comparison, not a null check.
    store.composeBlockedUntil = Date.now() - 1

    await store.retryLast("a1")

    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What is the soul?" }),
      expect.anything()
    )
    expect(deleteMessage).toHaveBeenCalledTimes(2)
  })

  it("still re-sends the swallowed question at the moment the quota lifts", async () => {
    // The guard has to read the COMPUTED lock, not `composeBlockedUntil`:
    // `clearRateLimitedBubbles` calls `retryLast` deliberately from inside the
    // lift, and the raw ref is not yet observably null to a guard written
    // against it.
    authState.signedIn = true
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "What is the soul?"), quotaBubble("a1")]
    store.composeBlockedUntil = Date.now() + 60_000

    store.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What is the soul?" }),
      expect.anything()
    )
  })
})
