import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessage } from "@shruti/stores/useChatStore.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const getTurn = vi.fn()
const sessionsGetById = vi.fn()
const listBySession = vi.fn().mockResolvedValue([])

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      chatSessions: { touch: vi.fn(), create: vi.fn(), getById: sessionsGetById },
      chatMessages: { delete: vi.fn().mockResolvedValue(undefined), listBySession },
      proactiveState: { markSeen: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("@shruti/utils/openStorePage.js", () => ({ openStorePage: vi.fn() }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  toastController: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
}))

const runChatTurn = vi.fn()
const replayChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: (...args: unknown[]) => replayChatTurn(...args),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const PENDING_KEY = "chat:pending_turns"

function seedPending(): void {
  prefs.set(
    PENDING_KEY,
    JSON.stringify([{ assistantMessageId: "a1", sessionId: "s1", createdAt: Date.now() }])
  )
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

/** A promise the test opens by hand, to pin down the exact interleaving of the
 *  two folds instead of hoping the scheduler produces it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = () => resolve()
  })
  return { promise, open }
}

/** Drain the microtask queue — every await in the folds resolves off already
 *  settled promises, so a few turns of the queue is the whole story. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The poll parked inside `getTurn`, resolved once the test has started the
 *  turn that must not lose its bubble. */
function deferredGetTurn(): (value: unknown) => void {
  let resolve!: (value: unknown) => void
  getTurn.mockImplementation(
    () =>
      new Promise((res) => {
        resolve = res as (value: unknown) => void
      })
  )
  return (value) => resolve(value)
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  getTurn.mockReset()
  runChatTurn.mockReset()
  replayChatTurn.mockReset()
  replayChatTurn.mockImplementation(async function* () {})
  listBySession.mockClear().mockResolvedValue([])
  sessionsGetById.mockReset().mockResolvedValue({ id: "s1" })
  seedPending()
})

afterEach(() => {
  vi.useRealTimers()
})

/* --------------------------------------------------------------------- */
/*   A resume that lands after a new turn started (issue #1781)           */
/* --------------------------------------------------------------------- */

describe("useChatStore — a resume and a live turn in one session", () => {
  /** Sets the scene the issue describes: a turn (`a1`) whose socket dropped is
   *  being polled for, its thinking bubble still on screen. */
  function openSessionWithPolledTurn(): ReturnType<typeof useChatStore> {
    const store = useChatStore()
    store.activeSessionId = "s1"
    store.messages = [
      userBubble("u1", "who is Krishna?"),
      assistantBubble("a1", { streaming: true }),
    ]
    return store
  }

  it("does not retarget the live stream when the buffered answer lands mid-turn", async () => {
    vi.useFakeTimers()
    const answerBuffered = deferredGetTurn()
    const liveDelta = gate()
    const liveFinal = gate()
    const replayFinal = gate()

    runChatTurn.mockImplementation(async function* () {
      yield { kind: "user-message", message: userBubble("u2", "and who is Radha?") }
      yield { kind: "assistant-placeholder", messageId: "a2" }
      await liveDelta.promise
      yield { kind: "delta", text: "Radha is" }
      await liveFinal.promise
      yield { kind: "finalised", message: assistantBubble("a2", { content: "Radha is" }) }
    })
    replayChatTurn.mockImplementation(async function* () {
      yield { kind: "assistant-placeholder", messageId: "a1" }
      yield { kind: "delta", text: "Krishna is" }
      await replayFinal.promise
      yield { kind: "finalised", message: assistantBubble("a1", { content: "Krishna is" }) }
    })

    const store = openSessionWithPolledTurn()
    void store.resumePendingTurns()
    await flush()

    // The composer is live during a resume poll, so this send is ordinary —
    // and it happens inside the `getTurn` round trip, which is the whole race.
    void store.sendMessage("and who is Radha?")
    await flush()
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"])

    answerBuffered({ state: "done", events: [] })
    await flush()
    // The live turn streams while the replay is mid-fold: its prose belongs in
    // its OWN bubble. A store-wide streaming id handed it to `a1` instead.
    liveDelta.open()
    await flush()
    replayFinal.open()
    await flush()
    liveFinal.open()
    await flush()

    const byId = (id: string): ChatMessage | undefined => store.messages.find((m) => m.id === id)
    expect(byId("a2")?.content).toBe("Radha is")
    expect(byId("a1")?.content).toBe("Krishna is")
    // Two rows under one key is what `ChatMessageList`'s `v-for :key` renders
    // as the answer above the question plus a spinner that never stops.
    const ids = store.messages.map((m) => m.id)
    expect(ids).toEqual(["u1", "a1", "u2", "a2"])
    expect(store.messages.some((m) => m.streaming)).toBe(false)
  })

  it("leaves the new turn's placeholder alone while the polled turn still runs", async () => {
    vi.useFakeTimers()
    const stillRunning = deferredGetTurn()
    const liveDelta = gate()

    runChatTurn.mockImplementation(async function* () {
      yield { kind: "user-message", message: userBubble("u2", "and who is Radha?") }
      yield { kind: "assistant-placeholder", messageId: "a2" }
      await liveDelta.promise
      yield { kind: "delta", text: "Radha is" }
      yield { kind: "finalised", message: assistantBubble("a2", { content: "Radha is" }) }
    })

    const store = openSessionWithPolledTurn()
    void store.resumePendingTurns()
    await flush()

    void store.sendMessage("and who is Radha?")
    await flush()

    // The poll wakes up owning nothing: re-raising `a1`'s placeholder here is
    // what used to claim the bubble the live turn was about to write into.
    stillRunning({ state: "running", events: [] })
    await flush()
    liveDelta.open()
    await flush()

    const byId = (id: string): ChatMessage | undefined => store.messages.find((m) => m.id === id)
    expect(byId("a2")?.content).toBe("Radha is")
    // The polled turn keeps its own bubble — empty and spinning, as it should
    // be while the server is still generating it.
    expect(byId("a1")?.content).toBe("")
    expect(byId("a1")?.streaming).toBe(true)
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"])
  })
})
