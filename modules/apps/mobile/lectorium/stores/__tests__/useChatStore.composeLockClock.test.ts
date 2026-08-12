// @vitest-environment jsdom
// The lockout is read through `useNow`, whose interval only runs on a client
// (@vueuse no-ops its timers without a `window`) — the composer's unlock edge
// cannot be observed in the node environment.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"

/**
 * Issue #1742, moved into the #1741 bundle: the composer lockout and the
 * persisted usage chip were both decided by comparing a SERVER epoch
 * (`resets_at_epoch`) against the DEVICE clock. A device whose clock runs a
 * day slow reads every server epoch as a day further away and stays locked out
 * long after the real reset.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const prefs = new Map<string, string>()

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      chatSessions: { touch: vi.fn(), create: vi.fn(), getById: vi.fn() },
      chatMessages: {
        delete: vi.fn().mockResolvedValue(undefined),
        listBySession: vi.fn().mockResolvedValue([]),
      },
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
  useAuthStore: () => ({ quotaId: "q1", isPro: false, ensureFresh: vi.fn() }),
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

const runChatTurn = vi.fn()
vi.mock("@usecases", () => ({
  runChatTurn: (...args: unknown[]) => runChatTurn(...args),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"
import { streamChat } from "@infra/chat/http/chatClient.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000
/** How long the server says the quota stays exhausted. */
const RETRY_AFTER_S = 600
/** Server wall-clock at the moment of the 429 — an arbitrary fixed instant. */
const SERVER_NOW_MS = 1_800_000_000_000
/** …and the device believes it is a day earlier. */
const DEVICE_NOW_MS = SERVER_NOW_MS - DAY_MS

/** Epoch seconds of the reset the server is announcing, `s` from ITS now. */
function resetsIn(seconds: number): number {
  return Math.floor((SERVER_NOW_MS + seconds * 1000) / 1000)
}

/** A `rate_limited` turn event as `runChatTurn` forwards it from the client. */
function rateLimited(over: {
  retryAfter?: number
  resetsAtEpoch?: number
}): Record<string, unknown> {
  return {
    kind: "error" as const,
    code: "rate_limited",
    message: "Too many requests",
    tier: "anonymous",
    keyType: "user" as const,
    current: 10,
    limit: 10,
    ...over,
  }
}

function mockTurn(error: Record<string, unknown>): void {
  runChatTurn.mockImplementation(() =>
    (async function* () {
      yield { kind: "assistant-placeholder", messageId: "a1" as ChatMessageId }
      yield error
    })()
  )
}

/**
 * The 429 the REAL client produces for a given set of response headers, mapped
 * into the turn-event shape `runChatTurn` forwards. Composing the two layers
 * is the point: the regression was a transport that fabricated
 * `retryAfter: 60`, which only did damage once it reached the store's
 * precedence rule. Neither layer's test alone would have caught it.
 */
async function refusalFromServer(
  headers: Record<string, string>,
  detail: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = {
    ok: false,
    status: 429,
    headers: new Headers(headers),
    clone: () => ({ json: () => Promise.resolve({ detail }) }),
  } as unknown as Response
  for await (const event of streamChat([{ role: "user", content: "hi" }], "en", {
    request: (() => Promise.resolve(response)) as never,
    getAccessToken: () => Promise.resolve("token"),
  })) {
    const { type, ...rest } = event as { type: string } & Record<string, unknown>
    if (type === "error") return { kind: "error", ...rest }
  }
  throw new Error("the client yielded no error event")
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  runChatTurn.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(DEVICE_NOW_MS)
})

afterEach(() => {
  vi.useRealTimers()
})

/* --------------------------------------------------------------------- */

describe("useChatStore — quota deadlines on a device with a wrong clock", () => {
  /** The server sent a real `Retry-After` — a duration, so the skew cancels. */
  const withHeader = () =>
    rateLimited({ retryAfter: RETRY_AFTER_S, resetsAtEpoch: resetsIn(RETRY_AFTER_S) })

  it("unlocks the composer when the server's own retry window has passed", async () => {
    mockTurn(withHeader())
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)

    // The server said "ten minutes". Give it fifteen — measured on the same
    // device clock `isComposeBlocked` reads. Pinning the deadline to the
    // server epoch instead keeps the composer disabled for another ~24 h.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(store.isComposeBlocked).toBe(false)
  })

  it("keeps the composer locked for the whole window the server gave", async () => {
    // The other direction: the fix must not unlock early either. Nine minutes
    // into a ten-minute window the composer is still shut.
    mockTurn(withHeader())
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(store.isComposeBlocked).toBe(true)
  })

  it("expires the persisted usage chip on the same window, across a restart", async () => {
    mockTurn(withHeader())
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    expect(store.chatUsage).toMatchObject({ current: 10, limit: 10 })

    // The snapshot IS persisted, so unlike the in-memory lockout it survives a
    // cold start — an exhausted 10/10 chip staring at a user whose quota reset
    // ages ago. Re-hydrating after the window must drop it.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    store.resetComposeLock()
    await vi.waitFor(() => expect(store.chatUsage).toBeNull())
  })
})

/* --------------------------------------------------------------------- */
/*   The shape that broke: a reset instant and no `Retry-After` header     */
/* --------------------------------------------------------------------- */

describe("useChatStore — a 429 whose only deadline is `resets_at_epoch`", () => {
  beforeEach(() => {
    // This is the e2e's server: no `Retry-After`, a reset 12 s out, and a
    // device clock that is simply correct. The bug had nothing to do with skew
    // — the transport minted `retryAfter: 60`, the store preferred it, and the
    // composer sat locked for a minute against a twelve-second reset.
    vi.setSystemTime(SERVER_NOW_MS)
  })

  it("ends the lockout at the server's deadline, not 60 s later", async () => {
    mockTurn(await refusalFromServer({}, { tier: "free", resets_at_epoch: resetsIn(12) }))
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.isComposeBlocked).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.isComposeBlocked).toBe(false)
  })

  it("uses the wait the server measured when it dates its response", async () => {
    // Same 12 s reset, but the response carries `Date` — so the deadline is a
    // server-measured duration counted from the device's own now, and a device
    // clock that is a day slow cannot stretch it.
    vi.setSystemTime(SERVER_NOW_MS - DAY_MS)
    mockTurn(
      await refusalFromServer(
        { Date: new Date(SERVER_NOW_MS).toUTCString() },
        { tier: "free", resets_at_epoch: resetsIn(12) }
      )
    )
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.isComposeBlocked).toBe(false)
  })

  it("still locks a bare 429 that carries no deadline at all", async () => {
    // Nothing to go on. The store — not the transport — supplies the last
    // resort, so it can never outrank information the server actually sent.
    mockTurn(await refusalFromServer({}, {}))
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId

    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.isComposeBlocked).toBe(true)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(store.isComposeBlocked).toBe(false)
  })
})

/* --------------------------------------------------------------------- */
/*        The lock has to live in the store, not on the textarea          */
/* --------------------------------------------------------------------- */

describe("useChatStore — a send dispatched while the lockout is armed", () => {
  beforeEach(() => {
    vi.setSystemTime(SERVER_NOW_MS)
  })

  /** A lock that outlives the test, so nothing auto-lifts underneath it. */
  async function armLock(): Promise<ReturnType<typeof useChatStore>> {
    mockTurn(await refusalFromServer({}, { tier: "free", resets_at_epoch: resetsIn(3600) }))
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)
    return store
  }

  it("issues no request for a chip tapped while locked (#1780)", async () => {
    const store = await armLock()
    const before = store.messages.length
    runChatTurn.mockClear()

    // What a suggestion pill / focus-card question does: call `sendMessage`
    // straight, with no composer in the way. Disabling the textarea never
    // covered this path, so every tap spent another increment of a server
    // counter that is bumped before the comparison and never refunded.
    await store.sendMessage("What is karma?")

    expect(runChatTurn).not.toHaveBeenCalled()
    // …and nothing half-built is left behind: no user bubble for a turn that
    // never happened, and the composer stays free for the next attempt.
    expect(store.messages).toHaveLength(before)
    expect(store.sending).toBe(false)
  })

  it("starts no session for a pill tapped from the empty state (#1780)", async () => {
    // The pill resets the thread first, so an unguarded send also wrote a
    // brand-new session row — a dead chat in history per tap.
    const store = await armLock()
    store.startNewSession()
    await store.sendMessage("What is karma?")

    expect(store.activeSessionId).toBeNull()
    expect(store.sessions).toHaveLength(0)
  })

  it("sends again once the deadline passes", async () => {
    // The guard is the lockout's, not a permanent mute: the same call goes
    // through the moment the window closes.
    mockTurn(await refusalFromServer({}, { tier: "free", resets_at_epoch: resetsIn(12) }))
    const store = useChatStore()
    store.activeSessionId = "s1" as ChatSessionId
    await store.sendMessage("who is Krishna?")
    expect(store.isComposeBlocked).toBe(true)

    await vi.advanceTimersByTimeAsync(15_000)
    runChatTurn.mockClear()
    await store.sendMessage("What is karma?")
    expect(runChatTurn).toHaveBeenCalledTimes(1)
  })
})
