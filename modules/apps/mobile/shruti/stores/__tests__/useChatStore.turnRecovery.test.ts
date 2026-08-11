import { beforeEach, describe, expect, it, vi } from "vitest"
import { watch } from "vue"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { RunChatTurnEvent } from "@usecases"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const getTurn = vi.fn()
const deleteMessage = vi.fn().mockResolvedValue(undefined)
const listBySession = vi.fn().mockResolvedValue([])

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      chatSessions: { touch: vi.fn(), create: vi.fn() },
      chatMessages: { delete: deleteMessage, listBySession },
      proactiveState: {},
    }),
    chatStreamClient: {},
    chatTitleService: {},
    chatQuestionsService: {},
    chatFeedbackService: {},
    chatResumeService: { getTurn, cancelTurn: vi.fn() },
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
  toastController: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
}))

const runChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"
import { onTurnSettled, type TurnSettledEvent } from "@shruti/chat/turnNotificationEvents.js"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000
const PENDING_KEY = "chat:pending_turns"

function seedPending(createdAt: number): void {
  prefs.set(PENDING_KEY, JSON.stringify([{ assistantMessageId: "a1", sessionId: "s1", createdAt }]))
}

function userBubble(id: string, content: string): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "user",
    content,
    createdAt: 1,
  }
}

function assistantBubble(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content: "",
    createdAt: 2,
    ...extra,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  getTurn.mockReset()
  deleteMessage.mockClear().mockResolvedValue(undefined)
  listBySession.mockClear().mockResolvedValue([])
  runChatTurn.mockReset()
})

/* --------------------------------------------------------------------- */
/*        1. An expired resume buffer must not spin forever               */
/* --------------------------------------------------------------------- */

describe("useChatStore — a turn whose server buffer is gone (issue #1610)", () => {
  it("converts the thinking placeholder into a retryable failed bubble", async () => {
    seedPending(Date.now() - DAY_MS - 60_000)
    getTurn.mockResolvedValue(null)

    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { streaming: true }),
    ]

    await store.resumePendingTurns()
    await vi.waitFor(async () => expect(await store.listPendingTurns()).toEqual([]))

    const bubble = store.messages.find((m) => m.id === "a1")
    // The bubble survives — it is what carries the Retry affordance. Dropping
    // it (or leaving `streaming` up) is the defect this test guards.
    expect(bubble).toBeDefined()
    expect(bubble?.streaming).toBe(false)
    expect(bubble?.error).toEqual({ kind: "failed", code: "stream" })
    // …and the prompt it answers is still there, so `retryLast` can resend it.
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1"])
  })

  it("keeps partial prose and marks it truncated rather than blanking it", async () => {
    seedPending(Date.now() - DAY_MS - 60_000)
    getTurn.mockResolvedValue(null)

    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { content: "Krishna is", streaming: true }),
    ]

    await store.resumePendingTurns()
    await vi.waitFor(async () => expect(await store.listPendingTurns()).toEqual([]))

    const bubble = store.messages.find((m) => m.id === "a1")
    expect(bubble?.content).toBe("Krishna is")
    expect(bubble?.streaming).toBe(false)
    expect(bubble?.error).toEqual({ kind: "truncated", reason: "stream" })
  })

  it("leaves a still-young turn alone — a 404 race must not lose it", async () => {
    seedPending(Date.now())
    getTurn.mockResolvedValue(null)

    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [userBubble("u1", "q"), assistantBubble("a1", { streaming: true })]

    await store.resumePendingTurns()
    await vi.waitFor(() => expect(getTurn).toHaveBeenCalled())

    expect(store.messages.find((m) => m.id === "a1")?.streaming).toBe(true)
    expect(await store.listPendingTurns()).toHaveLength(1)
  })

  it("also gives up on a turn stuck `running` past the buffer TTL", async () => {
    seedPending(Date.now() - DAY_MS - 60_000)
    getTurn.mockResolvedValue({ state: "running", events: [] })

    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [userBubble("u1", "q"), assistantBubble("a1", { streaming: true })]

    await store.resumePendingTurns()
    await vi.waitFor(async () => expect(await store.listPendingTurns()).toEqual([]))

    const bubble = store.messages.find((m) => m.id === "a1")
    expect(bubble?.streaming).toBe(false)
    expect(bubble?.error).toEqual({ kind: "failed", code: "stream" })
  })
})

/* --------------------------------------------------------------------- */
/*        2. Retry must not blank the conversation for a frame            */
/* --------------------------------------------------------------------- */

describe("useChatStore.retryLast — no blank frame (issue #1610)", () => {
  /** Record EVERY `messages` assignment synchronously, so a list that is
   *  empty for a single tick is caught — that tick is what the user sees as
   *  the welcome illustration flashing back. */
  function recordMessageWrites(store: ReturnType<typeof useChatStore>): ChatMessage[][] {
    const writes: ChatMessage[][] = []
    watch(
      () => store.messages,
      (v) => writes.push(v.slice()),
      { flush: "sync" }
    )
    return writes
  }

  function mockTurn(events: RunChatTurnEvent[]): void {
    runChatTurn.mockImplementation(async function* () {
      for (const e of events) yield e
    })
  }

  it("keeps the failed turn on screen until the replacement bubble lands", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { error: { kind: "failed", code: "network" } }),
    ]
    const writes = recordMessageWrites(store)

    const replacementUser = userBubble("u2", "who is Krishna?")
    const replacementAssistant = assistantBubble("a2", { content: "The Supreme Person." })
    mockTurn([
      { kind: "user-message", message: replacementUser },
      { kind: "assistant-placeholder", messageId: "a2" as ChatMessageId },
      { kind: "finalised", message: replacementAssistant },
    ])

    await store.retryLast()

    // Not one intermediate state was an empty thread, and every one of them
    // carried the user's prompt.
    expect(writes.length).toBeGreaterThan(0)
    for (const snapshot of writes) {
      expect(snapshot.length).toBeGreaterThan(0)
      expect(snapshot.some((m) => m.role === "user" && m.content === "who is Krishna?")).toBe(true)
    }
    // The old pair is gone by the end — swapped, not accumulated.
    expect(store.messages.map((m) => m.id)).toEqual(["u2", "a2"])
  })

  it("does not resend the replaced turn as history", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { error: { kind: "failed", code: "network" } }),
    ]
    mockTurn([{ kind: "user-message", message: userBubble("u2", "who is Krishna?") }])

    await store.retryLast()

    const input = runChatTurn.mock.calls[0][0] as { history: unknown[]; text: string }
    expect(input.text).toBe("who is Krishna?")
    // The failed turn is still in `messages` when the send starts — it must be
    // filtered out, or the server sees the same prompt twice.
    expect(input.history).toEqual([])
  })

  it("leaves the failed turn in place when the send never starts a turn", async () => {
    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { error: { kind: "failed", code: "network" } }),
    ]
    // A turn that dies before yielding `user-message` (e.g. the pre-stream
    // fetch throws): nothing replaces the pair, so nothing may remove it.
    mockTurn([{ kind: "error", code: "network", message: "offline" }])

    await store.retryLast()

    expect(store.messages.some((m) => m.role === "user" && m.content === "who is Krishna?")).toBe(
      true
    )
  })
})

/* --------------------------------------------------------------------- */
/*      3. A turn that dies by exception must not strand its record       */
/* --------------------------------------------------------------------- */

describe("useChatStore.sendMessage — a turn that dies by exception (issue #1733)", () => {
  /** Every `turnSettled` the bus carried during one test. */
  function recordSettles(): { events: TurnSettledEvent[]; stop: () => void } {
    const events: TurnSettledEvent[] = []
    const stop = onTurnSettled((e) => events.push(e))
    return { events, stop }
  }

  /** A turn that opens its placeholder — which arms the forward notification
   *  and writes the pending record — and then throws instead of finishing. */
  function mockTurnThatThrows(err: Error): void {
    runChatTurn.mockImplementation(async function* () {
      yield { kind: "assistant-placeholder", messageId: "a1" as ChatMessageId }
      throw err
    })
  }

  it.each([
    ["a protocol mismatch (426)", new ProtocolVersionMismatchError([2], 1)],
    ["a backend outage (503)", new BackendUnavailableError()],
    ["an unexpected throw", new Error("boom")],
  ])("clears the pending record and settles the turn as failed after %s", async (_name, err) => {
    const settles = recordSettles()
    mockTurnThatThrows(err)

    const store = useChatStore()
    store.activeSessionId = "s1"

    await store.sendMessage("who is Krishna?")

    // Left behind, this record re-raises a thinking placeholder on every
    // openSession for 24h and re-arms "Sadhu replied" at now+2s on every
    // backgrounding.
    expect(await store.listPendingTurns()).toEqual([])
    // …and only an `ok: false` settle cancels the notification already armed
    // at turn start.
    expect(settles.events).toEqual([{ assistantMessageId: "a1", sessionId: "s1", ok: false }])
    settles.stop()
  })

  it("still leaves a resumable drop alone — its record is the recovery handle", async () => {
    const settles = recordSettles()
    getTurn.mockResolvedValue({ state: "running", events: [] })
    // A dropped socket after the placeholder: the server keeps generating and
    // buffers the turn, so the record must SURVIVE for the resume poll.
    runChatTurn.mockImplementation(async function* () {
      yield { kind: "assistant-placeholder", messageId: "a1" as ChatMessageId }
      yield { kind: "error", code: "stream", message: "connection lost" }
    })

    const store = useChatStore()
    store.activeSessionId = "s1"

    await store.sendMessage("who is Krishna?")

    expect(await store.listPendingTurns()).toHaveLength(1)
    expect(settles.events).toEqual([])
    settles.stop()
  })

  it("forgets every in-flight turn on sign-out", async () => {
    const settles = recordSettles()
    seedPending(Date.now())

    const store = useChatStore()
    await store.clearPendingTurns()

    // Under the next identity these records only 404 — and keep notifying.
    expect(await store.listPendingTurns()).toEqual([])
    expect(settles.events).toEqual([{ assistantMessageId: "a1", sessionId: "s1", ok: false }])
    settles.stop()
  })
})
