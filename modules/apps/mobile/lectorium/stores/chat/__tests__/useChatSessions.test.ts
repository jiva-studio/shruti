import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { ChatFocusPayload } from "@lib/domain"
import type { TrackId } from "@lib/domain/core.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/index.js"
import type { PendingTurn } from "@lectorium/stores/chatPendingTurns.js"
import type { StreamTarget } from "../chatBubbles.js"
import type { ChatMessage, ChatSession } from "../chatTypes.js"
import type { ChatReadState } from "../useChatReadState.js"
import { useChatSessions, type ChatSessionsDeps } from "../useChatSessions.js"

function session(id: string, updatedAt = 0, title: string | null = `Title ${id}`): ChatSession {
  return { id, title, createdAt: 0, updatedAt } as ChatSession
}

const FOCUS: ChatFocusPayload = {
  trackId: "t-1" as TrackId,
  startMs: 0,
  endMs: 1,
  text: "  the soul   is eternal ",
}

function harness(opts: { sessions?: ChatSession[]; pending?: PendingTurn[] } = {}) {
  const sessions = ref<ChatSession[]>(opts.sessions ?? [])
  const activeSessionId = ref<string | null>(null)
  const messages = ref<ChatMessage[]>([])
  const sending = ref(false)

  const rows: ChatSession[] = [session("s-2", 2), session("s-1", 1)]
  const messagesBySession = new Map<string, ChatMessage[]>()
  const created: unknown[] = []
  const touched: [string, number][] = []
  let latestByTrack: ChatSession | null = null

  const sessionRepo = {
    list: vi.fn(async () => rows),
    findLatestByTrack: vi.fn(async () => latestByTrack),
    create: vi.fn(async (s: { id: string; title: string | null; trackId?: TrackId }) => {
      created.push(s)
      return session(s.id, 0, s.title)
    }),
    touch: vi.fn(async (id: string, at: number) => void touched.push([id, at])),
  }
  const messageRepo = {
    listBySession: vi.fn(async (id: string) => messagesBySession.get(id) ?? []),
    create: vi.fn(async (m: ChatMessage) => ({ ...m })),
  }

  const unseenCalls: [readonly string[], ReadonlySet<string>][] = []
  const forgotten: string[] = []
  const markSeen = vi.fn(async () => {})
  const listUnseenSessionIds = vi.fn<() => Promise<string[]>>(async () => [])

  const readState = {
    refreshUnseen: async (ids: readonly string[], live: ReadonlySet<string>) => {
      unseenCalls.push([ids, live])
    },
    forgetUnseen: (id: string) => void forgotten.push(id),
    clearAnswerUnread: vi.fn(async () => {}),
  } as unknown as ChatReadState

  const resumed: PendingTurn[] = []
  const turnControllers = new Map<string, AbortController>()
  const liveTargets = new Map<string, StreamTarget>()
  let cancelled = 0
  let composeSyncs = 0

  const deps: ChatSessionsDeps = {
    sessions,
    activeSessionId,
    messages,
    sending,
    chatRepos: () =>
      ({ sessions: sessionRepo, messages: messageRepo }) as unknown as ReturnType<
        ChatSessionsDeps["chatRepos"]
      >,
    proactiveState: () =>
      ({ listUnseenSessionIds, markSeen }) as unknown as IProactiveStateRepository,
    readState,
    readPending: async () => opts.pending ?? [],
    turnControllers,
    liveTargets,
    resumeOnePendingTurn: async (e) => void resumed.push(e),
    cancelSuggestions: () => void cancelled++,
    syncComposeBusy: () => void composeSyncs++,
  }

  return {
    api: useChatSessions(deps),
    sessions,
    activeSessionId,
    messages,
    sending,
    rows,
    messagesBySession,
    sessionRepo,
    messageRepo,
    created,
    touched,
    unseenCalls,
    forgotten,
    markSeen,
    listUnseenSessionIds,
    resumed,
    turnControllers,
    liveTargets,
    setLatestByTrack: (s: ChatSession | null) => void (latestByTrack = s),
    cancelled: () => cancelled,
    composeSyncs: () => composeSyncs,
  }
}

describe("useChatSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("exposes the open conversation, and null when none is open", () => {
    const h = harness({ sessions: [session("s-1"), session("s-2")] })

    expect(h.api.activeSession.value).toBeNull()

    h.activeSessionId.value = "s-2"
    expect(h.api.activeSession.value?.id).toBe("s-2")

    h.activeSessionId.value = "gone"
    expect(h.api.activeSession.value).toBeNull()
  })

  it("reports a session title only when it is non-blank", () => {
    const h = harness({
      sessions: [session("s-1", 0, "  Gita  "), session("s-2", 0, "   "), session("s-3", 0, null)],
    })

    expect(h.api.sessionTitleFor("s-1")).toBe("Gita")
    expect(h.api.sessionTitleFor("s-2")).toBeNull()
    expect(h.api.sessionTitleFor("s-3")).toBeNull()
    expect(h.api.sessionTitleFor("missing")).toBeNull()
  })

  it("loads the history list and reconciles the unread dots against it", async () => {
    const h = harness()
    h.listUnseenSessionIds.mockResolvedValue(["s-1"])

    await h.api.refreshSessions()

    expect(h.sessions.value.map((s) => s.id)).toEqual(["s-2", "s-1"])
    expect(h.unseenCalls).toHaveLength(1)
    expect(h.unseenCalls[0][0]).toEqual(["s-1"])
    expect([...h.unseenCalls[0][1]]).toEqual(["s-2", "s-1"])
  })

  it("keeps the freshly loaded list when the proactive repo is not ready", async () => {
    const h = harness()
    h.listUnseenSessionIds.mockRejectedValue(new Error("repo not ready"))

    await expect(h.api.refreshSessions()).resolves.toBeUndefined()

    expect(h.sessions.value.map((s) => s.id)).toEqual(["s-2", "s-1"])
    expect(h.unseenCalls).toEqual([])
  })

  it("opening a session loads its messages and clears its dot", async () => {
    const h = harness()
    h.messagesBySession.set("s-1", [{ id: "m-1" } as ChatMessage])

    await h.api.openSession("s-1")

    expect(h.activeSessionId.value).toBe("s-1")
    expect(h.messages.value.map((m) => m.id)).toEqual(["m-1"])
    expect(h.forgotten).toEqual(["s-1"])
    expect(h.markSeen).toHaveBeenCalled()
    expect(h.cancelled()).toBe(1)
  })

  it("re-opening the session already on screen is a no-op", async () => {
    const h = harness()
    h.activeSessionId.value = "s-1"

    await h.api.openSession("s-1")

    expect(h.messageRepo.listBySession).not.toHaveBeenCalled()
    expect(h.cancelled()).toBe(0)
  })

  it("survives a proactive markSeen that rejects", async () => {
    const h = harness()
    h.markSeen.mockRejectedValue(new Error("repo not ready"))

    await expect(h.api.openSession("s-1")).resolves.toBeUndefined()
    expect(h.forgotten).toEqual(["s-1"])
  })

  it("raises a thinking bubble and resumes a turn that was left in flight", async () => {
    const pending: PendingTurn = { sessionId: "s-1", assistantMessageId: "a-1" } as PendingTurn
    const h = harness({ pending: [pending] })

    await h.api.openSession("s-1")

    expect(h.messages.value.map((m) => [m.id, m.streaming])).toEqual([["a-1", true]])
    expect(h.resumed).toEqual([pending])
  })

  it("raises the bubble but does not re-resume a turn that is still streaming", async () => {
    const pending: PendingTurn = { sessionId: "s-1", assistantMessageId: "a-1" } as PendingTurn
    const h = harness({ pending: [pending] })
    h.turnControllers.set("s-1", new AbortController())
    const target = { messageId: "old" } as unknown as StreamTarget
    h.liveTargets.set("s-1", target)

    await h.api.openSession("s-1")

    expect(h.resumed).toEqual([])
    expect(target.messageId).toBe("a-1")
  })

  it("ignores a pending turn that belongs to another session", async () => {
    const h = harness({ pending: [{ sessionId: "s-9", assistantMessageId: "a-9" } as PendingTurn] })

    await h.api.openSession("s-1")

    expect(h.messages.value).toEqual([])
    expect(h.resumed).toEqual([])
  })

  it("starting a new chat clears the view without touching the history list", () => {
    const h = harness({ sessions: [session("s-1")] })
    h.activeSessionId.value = "s-1"
    h.messages.value = [{ id: "m-1" } as ChatMessage]
    h.sending.value = true

    h.api.startNewSession()

    expect(h.activeSessionId.value).toBeNull()
    expect(h.messages.value).toEqual([])
    expect(h.sending.value).toBe(false)
    expect(h.sessions.value).toHaveLength(1)
  })

  it("reuses the existing session anchored to a track", async () => {
    const h = harness()
    h.setLatestByTrack(session("s-track", 5))
    h.messagesBySession.set("s-track", [{ id: "m-1" } as ChatMessage])

    const id = await h.api.openOrCreateFocusedSession("t-1" as TrackId)

    expect(id).toBe("s-track")
    expect(h.activeSessionId.value).toBe("s-track")
    expect(h.messages.value.map((m) => m.id)).toEqual(["m-1"])
    expect(h.sessionRepo.create).not.toHaveBeenCalled()
  })

  it("creates a track-anchored session when the track has none", async () => {
    const h = harness({ sessions: [session("s-old")] })
    h.setLatestByTrack(null)

    const id = await h.api.openOrCreateFocusedSession("t-1" as TrackId)

    expect(h.created).toEqual([{ id, title: null, trackId: "t-1" }])
    expect(h.activeSessionId.value).toBe(id)
    expect(h.sessions.value.map((s) => s.id)).toEqual([id, "s-old"])
    expect(h.messages.value).toEqual([])
  })

  it("appends a focus message and floats its session to the top", async () => {
    const h = harness({ sessions: [session("s-a", 1), session("s-b", 2)] })
    h.activeSessionId.value = "s-b"

    const id = await h.api.appendFocusMessage(FOCUS)

    expect(h.messages.value.map((m) => m.id)).toEqual([id])
    expect(h.messages.value[0].focus).toEqual(FOCUS)
    expect(h.messages.value[0].content).toBe(FOCUS.text)
    expect(h.sessions.value.map((s) => s.id)).toEqual(["s-b", "s-a"])
    expect(h.touched[0][0]).toBe("s-b")
  })

  it("refuses a focus message with no session open", async () => {
    const h = harness()

    await expect(h.api.appendFocusMessage(FOCUS)).rejects.toThrow(/no active session/)
  })

  it("moveSessionToTop leaves an unknown id alone", () => {
    const h = harness({ sessions: [session("s-a", 1), session("s-b", 2)] })

    h.api.moveSessionToTop("nope", 99)

    expect(h.sessions.value.map((s) => s.id)).toEqual(["s-a", "s-b"])
  })

  it("moveSessionToTop restamps the row it moves", () => {
    const h = harness({ sessions: [session("s-a", 1), session("s-b", 2)] })

    h.api.moveSessionToTop("s-b", 99)

    expect(h.sessions.value.map((s) => [s.id, s.updatedAt])).toEqual([
      ["s-b", 99],
      ["s-a", 1],
    ])
  })

  it("ensureActiveSession returns the open session untouched", async () => {
    const h = harness()
    h.activeSessionId.value = "s-1"

    expect(await h.api.ensureActiveSession("anything")).toBe("s-1")
    expect(h.sessionRepo.create).not.toHaveBeenCalled()
  })

  it("ensureActiveSession titles a new session from the first question", async () => {
    const h = harness()

    const id = await h.api.ensureActiveSession("  Who   is Krishna?  ")

    expect(h.created).toEqual([{ id, title: "Who is Krishna?" }])
    expect(h.activeSessionId.value).toBe(id)
  })

  it("ensureActiveSession elides a title longer than the cap", async () => {
    const h = harness()

    await h.api.ensureActiveSession("x".repeat(80))

    const title = (h.created[0] as { title: string }).title
    expect(title).toHaveLength(48)
    expect(title.endsWith("…")).toBe(true)
  })

  it("searchSessions returns the whole list for a blank query", () => {
    const h = harness({ sessions: [session("s-a"), session("s-b")] })

    expect(h.api.searchSessions("   ").map((s) => s.id)).toEqual(["s-a", "s-b"])
  })

  it("searchSessions matches titles case-insensitively and skips untitled rows", () => {
    const h = harness({
      sessions: [session("s-a", 0, "Bhagavad Gita"), session("s-b", 0, null), session("s-c")],
    })

    expect(h.api.searchSessions("gita").map((s) => s.id)).toEqual(["s-a"])
    expect(h.api.searchSessions("zzz")).toEqual([])
  })
})
