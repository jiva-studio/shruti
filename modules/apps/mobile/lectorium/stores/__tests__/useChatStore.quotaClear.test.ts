import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessage } from "@lectorium/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/**
 * Issue #1609: the upsell card the user just acted on turned into a screenful
 * of blank space, and the question was never re-sent.
 *
 * `clearRateLimitedBubble` kept the row and only nulled its `error`. A failed
 * bubble carries `content: ""`, so an error-less one renders nothing at all —
 * while `ChatMessageList` still reserved `min-height: calc(100svh - 200px)`
 * for it as the tail slot. And `findIndex` cleared the OLDEST rate-limited
 * bubble, so with two on screen the current upsell stayed put.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const deleteMessage = vi.fn().mockResolvedValue(undefined)

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
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

vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn() }),
}))
vi.mock("@lectorium/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ quotaId: "q2", isPro: false, ensureFresh: vi.fn() }),
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

/** The bubble a quota 429 leaves behind: empty prose, all meaning in `error`. */
function quotaBubble(id: string, tier = "anonymous"): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content: "",
    createdAt: 2,
    error: { kind: "failed", code: "rate_limited", tier } as ChatMessage["error"],
  }
}

let replacementSeq = 0

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  replacementSeq = 0
  deleteMessage.mockClear().mockResolvedValue(undefined)
  // The real turn's first yield is the replacement user message — that is
  // what swaps out the retried pair (`retryReplacing`). Modelling it keeps
  // this test honest about what the user ends up looking at.
  runChatTurn.mockReset().mockImplementation((input: { text: string }) =>
    (async function* () {
      replacementSeq += 1
      yield {
        kind: "user-message",
        message: userBubble(`u-new${replacementSeq}`, input.text),
      }
    })()
  )
})

describe("useChatStore — the quota upsell card after the limit lifts (issue #1609)", () => {
  it("removes the bubble instead of leaving an empty row holding a screen of scroll", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "What is the soul?"), quotaBubble("a1")]

    store.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    // The defect: the row survived with `error: undefined` and `content: ""`,
    // rendering nothing while still being the tail slot.
    expect(store.messages.some((m) => m.id === "a1")).toBe(false)
    expect(store.messages.some((m) => m.content === "" && m.role === "assistant")).toBe(false)
  })

  it("re-sends the question the quota swallowed", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "What is the soul?"), quotaBubble("a1")]

    store.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    // The whole point of the upsell CTA: the user signed in to get THIS
    // answer. Previously nothing re-asked it and nothing said what to do next.
    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "What is the soul?" }),
      expect.anything()
    )
  })

  it("clears the CURRENT upsell, not just the oldest one", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [
      userBubble("u1", "first question"),
      quotaBubble("a1"),
      userBubble("u2", "second question"),
      quotaBubble("a2"),
    ]

    store.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    // `findIndex` used to clear a1 and leave a2 — a stale upsell over a
    // composer that had just been unlocked.
    expect(store.messages.some((m) => m.id === "a1")).toBe(false)
    expect(store.messages.some((m) => m.id === "a2")).toBe(false)
    // …and it is the LATEST question that gets re-asked.
    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second question" }),
      expect.anything()
    )
  })

  it("leaves unrelated failed bubbles alone", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    const networkFail: ChatMessage = {
      id: "a0" as ChatMessageId,
      sessionId: "s1" as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: 0,
      error: { kind: "failed", code: "network" } as ChatMessage["error"],
    }
    store.messages = [userBubble("u1", "q"), networkFail, userBubble("u2", "q2"), quotaBubble("a1")]

    store.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    // A network failure keeps its own Retry affordance — the quota sweep must
    // not eat it.
    expect(store.messages.some((m) => m.id === "a0")).toBe(true)
  })

  it("does nothing when there is no quota bubble on screen", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "q")]

    store.resetComposeLock()
    await new Promise((r) => setTimeout(r, 0))

    // A signout with a clean conversation must not fire a phantom turn.
    expect(runChatTurn).not.toHaveBeenCalled()
    expect(store.messages).toHaveLength(1)
  })

  it("drops the row outright when there is no question to re-ask", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    // A quota bubble with no user prompt before it (a resumed session whose
    // history hasn't loaded). Nothing to re-send — but it must not be left
    // behind as an empty row either.
    store.messages = [quotaBubble("a1")]

    store.resetComposeLock()
    await new Promise((r) => setTimeout(r, 0))

    expect(runChatTurn).not.toHaveBeenCalled()
    expect(store.messages).toEqual([])
  })
})
