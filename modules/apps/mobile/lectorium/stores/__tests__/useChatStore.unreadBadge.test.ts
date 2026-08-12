import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * Issue #1784: the Sadhu tab's unread dot outlived its conversation.
 *
 * `chat:unread_answers` was only ever emptied by opening the session, so a
 * reply that landed while the user was elsewhere and was then deleted unopened
 * left an id nothing could clear — and `refreshSessions` unioned it back into
 * the badge set on every load. The wipe missed the key too, leaving the dot lit
 * over an empty chat list.
 */

/* --------------------------------------------------------------------- */
/*                         Module-level mocks                            */
/* --------------------------------------------------------------------- */

const UNREAD_KEY = "chat:unread_answers"
const LAST_SEEN_KEY = "chat:last_seen_message"

const prefs = new Map<string, string>()
/** Session rows the mocked repository answers `list()` with. */
let rows: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = []
/** Session ids the proactive repo reports as unseen (the OTHER badge source). */
let proactiveUnseen: string[] = []

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({
    repositories: () => ({
      chatSessions: {
        list: vi.fn(async () => rows),
        delete: vi.fn(async (id: string) => {
          rows = rows.filter((r) => r.id !== id)
        }),
        clearAll: vi.fn(async () => {
          rows = []
        }),
        touch: vi.fn(),
        create: vi.fn(),
      },
      chatMessages: {
        listBySession: vi.fn().mockResolvedValue([]),
        deleteBySession: vi.fn(),
        clearAll: vi.fn(),
      },
      proactiveState: {
        listUnseenSessionIds: vi.fn(async () => proactiveUnseen),
        markSeen: vi.fn(async () => undefined),
      },
      unitOfWork: { run: (fn: (tx?: unknown) => Promise<void>) => fn(undefined) },
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
    notifications: { cancel: vi.fn(), schedule: vi.fn() },
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
vi.mock("@usecases", () => ({
  runChatTurn: vi.fn(),
  replayChatTurn: vi.fn(),
  submitChatFeedback: vi.fn(),
  recordInlineHintCooldown: vi.fn(),
}))

import { useChatStore } from "../useChatStore.js"

/* --------------------------------------------------------------------- */
/*                               Helpers                                  */
/* --------------------------------------------------------------------- */

function session(id: string): { id: string; title: string; createdAt: number; updatedAt: number } {
  return { id, title: `question in ${id}`, createdAt: 1, updatedAt: 2 }
}

function persistedUnread(): string[] {
  const raw = prefs.get(UNREAD_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

beforeEach(() => {
  setActivePinia(createPinia())
  prefs.clear()
  rows = [session("s1"), session("s2")]
  proactiveUnseen = []
})

describe("useChatStore — the unread dot and the conversation it belongs to (#1784)", () => {
  it("clears the badge when the conversation is deleted unopened", async () => {
    const store = useChatStore()
    await store.markAnswerUnread("s1")
    expect(store.unseenProactiveSessionIds.has("s1")).toBe(true)

    await store.deleteSession("s1")

    // The dot went out on the spot…
    expect(store.unseenProactiveSessionIds.has("s1")).toBe(false)
    // …and stayed out: the persisted id was the only thing that could light it
    // again, and there is no session left to open to clear it.
    expect(persistedUnread()).toEqual([])
    await store.refreshSessions()
    expect(store.unseenProactiveSessionIds.has("s1")).toBe(false)
  })

  it("forgets the deleted conversation's scroll anchor", async () => {
    const store = useChatStore()
    await store.markSessionSeen("s1", "m1")
    await store.markSessionSeen("s2", "m2")

    await store.deleteSession("s1")

    expect(await store.getLastSeenMessageId("s1")).toBeNull()
    // The surviving conversation keeps its anchor.
    expect(await store.getLastSeenMessageId("s2")).toBe("m2")
  })

  it("repairs a device already stuck with an id whose conversation is gone", async () => {
    prefs.set(UNREAD_KEY, JSON.stringify(["s1", "gone"]))

    const store = useChatStore()
    await store.refreshSessions()

    // Only the live conversation lights the badge; the orphan is pruned from
    // the preference too, so the repair survives the next launch.
    expect(store.unseenProactiveSessionIds).toEqual(new Set(["s1"]))
    expect(persistedUnread()).toEqual(["s1"])
  })

  it("still lights the dot for a proactive session outside the answers set", async () => {
    proactiveUnseen = ["s2"]

    const store = useChatStore()
    await store.refreshSessions()

    // The intersection applies to the persisted answers only — the SQL-derived
    // proactive half is left exactly as it was.
    expect(store.unseenProactiveSessionIds).toEqual(new Set(["s2"]))
  })

  it("takes both preference keys with it on the wipe", async () => {
    const store = useChatStore()
    await store.markAnswerUnread("s1")
    await store.markSessionSeen("s1", "m1")

    await store.clearAll()

    // "Delete account → also delete data on this device" routes here; emptying
    // the tables alone left the dot lit over an empty chat list.
    expect(prefs.has(UNREAD_KEY)).toBe(false)
    expect(prefs.has(LAST_SEEN_KEY)).toBe(false)
    expect(store.unseenProactiveSessionIds.size).toBe(0)
    await store.refreshSessions()
    expect(store.unseenProactiveSessionIds.size).toBe(0)
  })

  it("keeps clearing the badge when the session is opened", async () => {
    const store = useChatStore()
    await store.markAnswerUnread("s1")

    await store.openSession("s1")

    expect(store.unseenProactiveSessionIds.has("s1")).toBe(false)
    await vi.waitFor(() => expect(persistedUnread()).toEqual([]))
  })
})
