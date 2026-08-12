import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()
const getTurn = vi.fn()
const sessionsGetById = vi.fn()
const messagesClearAll = vi.fn().mockResolvedValue(undefined)
const sessionsClearAll = vi.fn().mockResolvedValue(undefined)

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      chatSessions: {
        touch: vi.fn(),
        create: vi.fn(),
        getById: sessionsGetById,
        clearAll: sessionsClearAll,
      },
      chatMessages: {
        delete: vi.fn().mockResolvedValue(undefined),
        listBySession: vi.fn().mockResolvedValue([]),
        clearAll: messagesClearAll,
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

const replayChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: vi.fn(),
  replayChatTurn: (...args: unknown[]) => replayChatTurn(...args),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"
import { onTurnSettled, type TurnSettledEvent } from "@shruti/chat/turnNotificationEvents.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const PENDING_KEY = "chat:pending_turns"
/** The ceiling the old `for (let i = 0; i < 60; i++)` loop imposed: 60 polls
 *  2.5 s apart, then a silent fall-out with the record and the thinking
 *  placeholder both left behind. */
const OLD_POLL_CEILING = 60

function seedPending(createdAt: number): void {
  prefs.set(PENDING_KEY, JSON.stringify([{ assistantMessageId: "a1", sessionId: "s1", createdAt }]))
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  getTurn.mockReset()
  replayChatTurn.mockReset()
  replayChatTurn.mockImplementation(async function* () {})
  sessionsGetById.mockReset()
  sessionsGetById.mockResolvedValue({ id: "s1" })
  messagesClearAll.mockClear()
  sessionsClearAll.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

/* --------------------------------------------------------------------- */
/*        1. A long turn must be followed until it settles                */
/* --------------------------------------------------------------------- */

describe("useChatStore — resume polling for a long-running turn", () => {
  it("keeps polling past the old ~150 s ceiling instead of giving up silently", async () => {
    vi.useFakeTimers()
    seedPending(Date.now())
    getTurn.mockResolvedValue({ state: "running", events: [] })

    const store = useChatStore()
    store.activeSessionId = "s1"

    await store.resumePendingTurns()
    // Well past 60 × 2.5 s. A research turn that takes ten minutes is ordinary;
    // the poll used to stop at ~2.5 min with no abandon, no error and no
    // reschedule, leaving the user watching dots for an answer already on the
    // server.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(getTurn.mock.calls.length).toBeGreaterThan(OLD_POLL_CEILING)
    // Still `running`, still inside the buffer TTL — so the record is kept,
    // not abandoned. Giving up early is the defect; giving up wrongly is too.
    expect(await store.listPendingTurns()).toHaveLength(1)
  })

  it("delivers the answer that lands after the old ceiling would have expired", async () => {
    vi.useFakeTimers()
    seedPending(Date.now())
    let polls = 0
    getTurn.mockImplementation(() => {
      polls += 1
      return Promise.resolve(
        polls > OLD_POLL_CEILING + 5
          ? { state: "done", events: [] }
          : { state: "running", events: [] }
      )
    })

    const store = useChatStore()
    store.activeSessionId = "s1"

    await store.resumePendingTurns()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    expect(replayChatTurn).toHaveBeenCalledOnce()
    expect(await store.listPendingTurns()).toEqual([])
  })
})

/* --------------------------------------------------------------------- */
/*        2. "Clear all chats" must not leave a turn to replay            */
/* --------------------------------------------------------------------- */

describe("useChatStore.clearAll — pending turns (issue #1741)", () => {
  it("drops the pending records and settles them", async () => {
    seedPending(Date.now())
    const settled: TurnSettledEvent[] = []
    const stop = onTurnSettled((e) => settled.push(e))

    const store = useChatStore()
    await store.clearAll()
    stop()

    // Left behind, the record outlives the wipe by the 24 h server buffer TTL:
    // the next resume replays a buffered answer into a session that no longer
    // exists and notifies about a tap target that leads nowhere.
    expect(await store.listPendingTurns()).toEqual([])
    // Settled as failed, so the pre-armed "Sadhu replied" notification is
    // cancelled rather than merely orphaned.
    expect(settled).toEqual([{ assistantMessageId: "a1", sessionId: "s1", ok: false }])
  })

  it("never replays a buffered answer into a session that is gone", async () => {
    // The record a `cancelAllStreams` abort cannot reach: its live stream had
    // already dropped, so there is no controller to abort and nothing removes
    // it — and it can even be written back after the truncate.
    seedPending(Date.now())
    sessionsGetById.mockResolvedValue(null)
    getTurn.mockResolvedValue({ state: "done", events: [] })
    const settled: TurnSettledEvent[] = []
    const stop = onTurnSettled((e) => settled.push(e))

    const store = useChatStore()
    await store.resumePendingTurns()
    await vi.waitFor(async () => expect(await store.listPendingTurns()).toEqual([]))
    stop()

    expect(replayChatTurn).not.toHaveBeenCalled()
    expect(settled).toEqual([{ assistantMessageId: "a1", sessionId: "s1", ok: false }])
  })
})
