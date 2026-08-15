import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * Issue #1840: the resume poll abandoned a followed turn the moment a
 * controller was registered for its session — before any `getTurn` — throwing
 * away an answer the server had already produced and was holding for the rest
 * of its 24 h buffer TTL. The abandoned bubble carries no usable Retry either:
 * both affordances require `isLast()`, and the newer question now sits after
 * it, so the loss is silent and permanent.
 *
 * The poll now runs its round to the `getTurn` and gives up only on a reading
 * that is not an answer (`missing` / `running` / unreachable) — a `done` or
 * `error` falls through to the same replay as any other recovery.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const getTurn = vi.fn()
const sessionsGetById = vi.fn()
const listBySession = vi.fn()
const deleteMessage = vi.fn().mockResolvedValue(undefined)

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      chatSessions: {
        touch: vi.fn(),
        create: vi.fn(),
        getById: sessionsGetById,
        clearAll: vi.fn().mockResolvedValue(undefined),
      },
      chatMessages: {
        delete: deleteMessage,
        listBySession,
        clearAll: vi.fn().mockResolvedValue(undefined),
      },
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

vi.mock("@lectorium/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn() }),
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
vi.mock("@lectorium/utils/openStorePage.js", () => ({ openStorePage: vi.fn() }))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@ionic/vue", () => ({
  toastController: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) },
}))

const replayChatTurn = vi.fn()
const runChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: (...args: unknown[]) => replayChatTurn(...args),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore, type ChatMessage } from "../useChatStore.js"
import { onTurnSettled, type TurnSettledEvent } from "@lectorium/chat/turnNotificationEvents.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const PENDING_KEY = "chat:pending_turns"

/** When the followed turn started. Read back by the assertions — the recovered
 *  answer has to be stamped with it, and `decideResumeRecovery` measures the
 *  buffer TTL against it, so it must sit on the same clock as the test. */
let turnStartedAt = 0

function seedPending(): void {
  turnStartedAt = Date.now()
  prefs.set(
    PENDING_KEY,
    JSON.stringify([{ assistantMessageId: "a1", sessionId: "s1", createdAt: turnStartedAt }])
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

/** The bubble the dropped live stream left spinning in the thread. */
function streamingBubble(content = ""): ChatMessage {
  return {
    id: "a1" as ChatMessageId,
    sessionId: "s1" as ChatSessionId,
    role: "assistant",
    content,
    createdAt: 2,
    streaming: true,
  }
}

/** The replay the store runs off the server buffer: the pinned placeholder,
 *  then the rebuilt reply. */
function replayYields(): void {
  replayChatTurn.mockImplementation(async function* (input: { assistantMessageId: string }) {
    yield { kind: "assistant-placeholder", messageId: input.assistantMessageId }
    yield {
      kind: "finalised",
      message: {
        id: input.assistantMessageId,
        sessionId: "s1",
        role: "assistant",
        content: "The soul is eternal.",
        createdAt: turnStartedAt,
      },
    }
  })
}

/** Register a live turn for the session and hold it open, the way an
 *  impatient re-ask does while the resume poll sleeps between rounds. */
function holdLiveTurn(): () => void {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  runChatTurn.mockImplementation(async function* () {
    yield { kind: "user-message", message: userBubble("u2", "and who is Balarama?") }
    yield { kind: "assistant-placeholder", messageId: "a2" as ChatMessageId }
    await held
  })
  return release
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  getTurn.mockReset()
  replayChatTurn.mockReset().mockImplementation(async function* () {})
  runChatTurn.mockReset().mockImplementation(async function* () {})
  sessionsGetById.mockReset().mockResolvedValue({ id: "s1" })
  listBySession.mockReset().mockResolvedValue([])
  deleteMessage.mockClear().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

/* --------------------------------------------------------------------- */

describe("useChatStore — a superseded resume poll (issue #1840)", () => {
  /** Poll → the user re-asks while it sleeps → the server finishes the
   *  followed turn. Returns once the live turn's fold is parked. */
  async function supersedeWith(state: "done" | "running" | "missing"): Promise<{
    store: ReturnType<typeof useChatStore>
    settled: TurnSettledEvent[]
    finish: () => Promise<void>
  }> {
    vi.useFakeTimers()
    seedPending()
    let finished = false
    getTurn.mockImplementation(() =>
      Promise.resolve(
        !finished
          ? { state: "running", events: [] }
          : state === "missing"
            ? null
            : { state, events: [] }
      )
    )
    const settled: TurnSettledEvent[] = []
    const stop = onTurnSettled((e) => settled.push(e))

    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    store.messages = [userBubble("u1", "what is the soul?"), streamingBubble()]
    await store.resumePendingTurns()
    await vi.advanceTimersByTimeAsync(3000)

    const release = holdLiveTurn()
    const live = store.sendMessage("and who is Balarama?")
    finished = true
    await vi.advanceTimersByTimeAsync(20_000)

    return {
      store,
      settled,
      finish: async () => {
        release()
        await live
        stop()
      },
    }
  }

  it("replays the answer the server had already produced", async () => {
    replayYields()
    const { store, finish } = await supersedeWith("done")

    // The defect: `giveUpOnPendingTurn` ran before any `getTurn`, so this
    // answer — generated and billed for — was never fetched again.
    expect(replayChatTurn).toHaveBeenCalledOnce()
    const bubble = store.messages.find((m) => m.id === "a1")
    expect(bubble?.content).toBe("The soul is eternal.")
    expect(bubble?.streaming).toBeFalsy()
    expect(bubble?.error).toBeUndefined()
    await finish()
  })

  it("keeps the recovered answer above the newer question", async () => {
    replayYields()
    const { store, finish } = await supersedeWith("done")

    // In memory the bubble is rebuilt in its own slot…
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"])
    // …and on disk it is stamped with the turn's start, not the moment of
    // recovery, so a session re-read from SQLite (ORDER BY created_at) does
    // not float it below the question the user asked in the meantime.
    expect(replayChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: "a1", finalisedCreatedAt: turnStartedAt }),
      expect.anything()
    )
    await finish()
  })

  it("rebuilds a truncated stub in place instead of re-appending it", async () => {
    // A live stream that dropped mid-prose left a truncated row on disk and a
    // bubble with partial text on screen. The replay drops the row (PK) — but
    // splicing the bubble out too made the replay's placeholder re-append it,
    // i.e. under the newer turn.
    listBySession.mockResolvedValue([
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        content: "The soul is",
        createdAt: 2,
        error: { kind: "truncated", reason: "stream" },
      },
    ])
    replayYields()
    const { store, finish } = await supersedeWith("done")

    expect(deleteMessage).toHaveBeenCalledWith("a1")
    expect(store.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"])
    // Rebuilt from the buffer, not the partial prose plus the buffer.
    expect(store.messages.find((m) => m.id === "a1")?.content).toBe("The soul is eternal.")
    await finish()
  })

  it("never writes the recovered answer into the live turn's bubble", async () => {
    replayYields()
    const { store, finish } = await supersedeWith("done")

    // The per-poll `StreamTarget` is what fixed #1781; the replay must not be
    // handed the live turn's. Its bubble is still an untouched placeholder.
    const live = store.messages.find((m) => m.id === "a2")
    expect(live?.streaming).toBe(true)
    expect(live?.content).toBe("")
    await finish()
  })

  it("settles the recovered turn without a 'Sadhu replied' surface", async () => {
    replayYields()
    const { settled, finish } = await supersedeWith("done")

    // The answer lands in a thread the user is looking at, under a turn of
    // their own — notifying about it is noise. The settle still goes out so
    // the forward notification armed at turn start is cancelled.
    expect(settled).toContainEqual({
      assistantMessageId: "a1",
      sessionId: "s1",
      ok: true,
      silent: true,
    })
    await finish()
  })

  it("still drops the record when the server has no answer to give (#1782)", async () => {
    const { store, settled, finish } = await supersedeWith("missing")

    // A superseding turn is still certain evidence that no further round of
    // this poll may run. Left behind, the record re-arms the notification
    // after every backgrounding and re-raises a phantom placeholder for 24 h.
    expect(replayChatTurn).not.toHaveBeenCalled()
    expect((await store.listPendingTurns()).map((p) => p.assistantMessageId)).toEqual(["a2"])
    expect(settled).toContainEqual({ assistantMessageId: "a1", sessionId: "s1", ok: false })
    const bubble = store.messages.find((m) => m.id === "a1")
    expect(bubble?.streaming).toBe(false)
    expect(bubble?.error).toEqual({ kind: "failed", code: "stream" })
    await finish()
  })

  it("does not follow a superseded turn that is still generating", async () => {
    const { store, finish } = await supersedeWith("running")

    expect(replayChatTurn).not.toHaveBeenCalled()
    expect((await store.listPendingTurns()).map((p) => p.assistantMessageId)).toEqual(["a2"])
    await finish()
  })
})
