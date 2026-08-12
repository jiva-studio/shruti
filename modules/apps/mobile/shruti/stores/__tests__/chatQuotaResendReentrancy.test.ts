import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { AuthSession } from "@ports/app/auth.js"

/**
 * Issue #1779: signing in from the quota banner showed the question twice.
 *
 * `applySession` writes `userId`, `quotaId` and `signedIn` in one synchronous
 * block and each has its own watcher, so all three land in the SAME Vue flush
 * and each calls `resetComposeLock` → `clearRateLimitedBubbles({resend:true})`
 * → `retryLast`. Nothing latched synchronously (`sending` is only set inside
 * `sendMessage`, two awaited deletes later), so all three entered; the two
 * losers' `finally` nulled `retryReplacing` before the winner's `user-message`
 * could read it, and the retried pair was never swapped out.
 *
 * Both stores are real here — the defect lives in the seam between them, and
 * mocking either end hides it.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const deleteMessage = vi.fn().mockResolvedValue(undefined)
const listeners = new Set<(s: AuthSession | null) => void>()

/** What the auth adapter's `setSession` does to everyone subscribed. */
function emitSession(s: AuthSession | null): void {
  for (const l of [...listeners]) l(s)
}

const ANON: AuthSession = {
  userId: "anon-1",
  email: null,
  name: null,
  picture: null,
  anonymous: true,
  accessTokenExpiresAt: Date.now() + 3_600_000,
  tier: "free",
  tierExpiresAt: null,
  quotaId: "q-anon",
}

/** The session the email-OTP upgrade hands back: a different user row, a new
 *  quota bucket, no longer anonymous — all three watchers at once. */
const SIGNED_IN: AuthSession = {
  ...ANON,
  userId: "user-9",
  email: "reader@example.com",
  anonymous: false,
  quotaId: "q-signed",
}

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    auth: {
      initialize: () => Promise.resolve(ANON),
      onSessionChange: (l: (s: AuthSession | null) => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      fetchMe: vi.fn().mockResolvedValue(null),
      refreshTokens: vi.fn(),
      getSession: () => null,
    },
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
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ logOut: vi.fn() }),
}))
vi.mock("@shruti/services/monitoring/index.js", () => ({
  setMonitoringUser: vi.fn(),
  setMonitoringTag: vi.fn(),
}))
vi.mock("@shruti/services/dataWipe.js", () => ({ wipeLocalUserData: vi.fn() }))
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
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

const runChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"
import { useAuthStore } from "../useAuthStore.js"

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

const QUESTION = "What is the soul?"

let replacementSeq = 0

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  listeners.clear()
  replacementSeq = 0
  deleteMessage.mockClear().mockResolvedValue(undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  // The real turn's first yield is the replacement user message — the event
  // that swaps out the retried pair (`retryReplacing`).
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

/** Boot the auth store on the anonymous session the app mints at launch, and
 *  leave the chat thread where an anonymous quota 429 leaves it. */
async function anonymousAtTheLimit() {
  const auth = useAuthStore()
  const chat = useChatStore()
  await auth.restore()
  chat.activeSessionId = "s1" as ChatSessionId
  chat.messages = [userBubble("u1", QUESTION), quotaBubble("a1")]
  deleteMessage.mockClear()
  runChatTurn.mockClear()
  return { auth, chat }
}

describe("chat quota re-send — signing in from the banner (issue #1779)", () => {
  it("re-sends once when userId, quotaId and signedIn all flip in one flush", async () => {
    const { auth } = await anonymousAtTheLimit()

    emitSession(SIGNED_IN)
    await nextTick()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalled())

    // All three watchers really did fire on this edge — that is the premise.
    expect(auth.userId).toBe("user-9")
    expect(auth.quotaId).toBe("q-signed")
    expect(auth.signedIn).toBe(true)

    // `retryLast` deletes exactly two rows (the question + the failed reply)
    // per entry, so three entries showed up as six deletes.
    expect(deleteMessage).toHaveBeenCalledTimes(2)
    expect(runChatTurn).toHaveBeenCalledTimes(1)
    expect(runChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: QUESTION }),
      expect.anything()
    )
  })

  it("swaps the retried pair out instead of leaving the question on screen twice", async () => {
    const { chat } = await anonymousAtTheLimit()

    emitSession(SIGNED_IN)
    await vi.waitFor(() => expect(chat.messages.some((m) => m.id.startsWith("u-new"))).toBe(true))

    // The defect, exactly as the user saw it: the original question, the dead
    // limit card, and the same question again.
    expect(chat.messages.filter((m) => m.content === QUESTION)).toHaveLength(1)
    expect(chat.messages.some((m) => m.id === "u1")).toBe(false)
    expect(chat.messages.some((m) => m.id === "a1")).toBe(false)
  })

  it("still re-sends on a later lift once the first turn has settled", async () => {
    const { chat } = await anonymousAtTheLimit()

    emitSession(SIGNED_IN)
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(chat.sending).toBe(false))

    // The latch is a re-entrancy guard for one flush, not a cooldown: a second
    // entitlement change (sign in, hit the new limit, upgrade to Pro) must
    // still get the question re-asked.
    chat.messages = [userBubble("u2", "second question"), quotaBubble("a2")]
    chat.resetComposeLock()
    await vi.waitFor(() => expect(runChatTurn).toHaveBeenCalledTimes(2))
    expect(runChatTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "second question" }),
      expect.anything()
    )
  })
})
