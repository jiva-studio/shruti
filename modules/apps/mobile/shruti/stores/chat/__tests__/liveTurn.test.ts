import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { PendingTurn } from "@shruti/stores/chatPendingTurns.js"
import type { StreamTarget } from "@usecases/chat/chatBubbles.js"
import type { ChatMessage } from "@usecases/chat/chatThread.js"

const settled = vi.hoisted(() => [] as unknown[])
vi.mock("@shruti/chat/turnNotificationEvents.js", () => ({
  emitTurnSettled: (e: unknown) => void settled.push(e),
}))

const { settleLiveTurn } = await import("../liveTurn.js")
type LiveTurn = import("../liveTurn.js").LiveTurn

const SESSION = "s-1" as ChatSessionId
const OTHER = "s-2"
const ASSISTANT = "a-1" as ChatMessageId
const NOW = 1_700_000_000_000

function bubble(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: ASSISTANT,
    sessionId: SESSION,
    role: "assistant",
    content: "",
    createdAt: NOW,
    ...over,
  }
}

function liveTurn(over: Partial<LiveTurn> = {}): LiveTurn {
  return {
    sessionId: SESSION,
    target: { messageId: ASSISTANT },
    assistantMsgId: ASSISTANT,
    resumableDrop: false,
    settled: false,
    pendingWrite: Promise.resolve(),
    ...over,
  }
}

function harness(
  opts: { active?: string; messages?: ChatMessage[]; pending?: PendingTurn[] } = {}
) {
  const deps = {
    messages: ref<ChatMessage[]>(opts.messages ?? []),
    sending: ref(true),
    activeSessionId: ref<string | null>(opts.active ?? SESSION),
    turnControllers: new Map<string, AbortController>(),
    liveTargets: new Map<string, StreamTarget>(),
    readPending: vi.fn(async () => opts.pending ?? []),
    removePending: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    resumeOnePendingTurn: vi.fn<(entry: PendingTurn) => Promise<void>>(async () => undefined),
  }
  return deps
}

beforeEach(() => {
  settled.length = 0
})

describe("settleLiveTurn — registry and compose state", () => {
  it("deregisters its own controller and target", async () => {
    const deps = harness()
    const turn = liveTurn({ settled: true })
    const controller = new AbortController()
    deps.turnControllers.set(SESSION, controller)
    deps.liveTargets.set(SESSION, turn.target)

    await settleLiveTurn(turn, controller, deps)

    expect(deps.turnControllers.has(SESSION)).toBe(false)
    expect(deps.liveTargets.has(SESSION)).toBe(false)
    expect(deps.sending.value).toBe(false)
  })

  it("leaves a newer turn's controller and target in place", async () => {
    const deps = harness()
    const newer = new AbortController()
    const newerTarget: StreamTarget = { messageId: null }
    deps.turnControllers.set(SESSION, newer)
    deps.liveTargets.set(SESSION, newerTarget)

    await settleLiveTurn(liveTurn({ settled: true }), new AbortController(), deps)

    expect(deps.turnControllers.get(SESSION)).toBe(newer)
    expect(deps.liveTargets.get(SESSION)).toBe(newerTarget)
  })

  it("does not release the compose state of a session no longer on screen", async () => {
    const deps = harness({ active: OTHER })

    await settleLiveTurn(liveTurn({ settled: true }), new AbortController(), deps)

    expect(deps.sending.value).toBe(true)
  })
})

describe("settleLiveTurn — a resumable drop", () => {
  it("raises a thinking bubble and resumes from the persisted pending entry", async () => {
    const persisted = { assistantMessageId: ASSISTANT, sessionId: SESSION, createdAt: 5 }
    const deps = harness({
      pending: [{ assistantMessageId: "other", sessionId: SESSION, createdAt: 1 }, persisted],
    })

    await settleLiveTurn(liveTurn({ resumableDrop: true }), new AbortController(), deps)

    expect(deps.messages.value).toEqual([
      expect.objectContaining({ id: ASSISTANT, streaming: true }),
    ])
    expect(deps.resumeOnePendingTurn).toHaveBeenCalledWith(persisted)
    expect(deps.removePending).not.toHaveBeenCalled()
    expect(settled).toEqual([])
  })

  it("synthesizes the entry when the pending write has not landed", async () => {
    const deps = harness()

    await settleLiveTurn(liveTurn({ resumableDrop: true }), new AbortController(), deps)

    expect(deps.resumeOnePendingTurn).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: ASSISTANT, sessionId: SESSION })
    )
  })

  it("adds no bubble to a session the user left", async () => {
    const deps = harness({ active: OTHER })

    await settleLiveTurn(liveTurn({ resumableDrop: true }), new AbortController(), deps)

    expect(deps.messages.value).toEqual([])
    expect(deps.resumeOnePendingTurn).toHaveBeenCalledOnce()
  })
})

describe("settleLiveTurn — an abandoned turn", () => {
  it("drops the still-streaming placeholder, detaches the target and clears the record", async () => {
    const keep = bubble({ id: "u-1" as ChatMessageId, role: "user" })
    const deps = harness({ messages: [keep, bubble({ streaming: true })] })
    const turn = liveTurn()

    await settleLiveTurn(turn, new AbortController(), deps)

    expect(deps.messages.value).toEqual([keep])
    expect(turn.target.messageId).toBeNull()
    expect(deps.removePending).toHaveBeenCalledOnce()
    expect(deps.removePending).toHaveBeenCalledWith(ASSISTANT)
    expect(settled).toEqual([{ assistantMessageId: ASSISTANT, sessionId: SESSION, ok: false }])
  })

  it("keeps a failed bubble whose streaming already stopped", async () => {
    const failed = bubble({ streaming: false, content: "partial" })
    const deps = harness({ messages: [failed] })

    await settleLiveTurn(liveTurn(), new AbortController(), deps)

    expect(deps.messages.value).toEqual([failed])
  })

  it("leaves a target that moved to another bubble", async () => {
    const deps = harness({ messages: [bubble({ streaming: true })] })
    const turn = liveTurn({ target: { messageId: "a-2" as ChatMessageId } })

    await settleLiveTurn(turn, new AbortController(), deps)

    expect(turn.target.messageId).toBe("a-2")
  })

  it("touches nothing once a lifecycle event settled the turn", async () => {
    const deps = harness({ messages: [bubble({ streaming: false })] })

    await settleLiveTurn(liveTurn({ settled: true }), new AbortController(), deps)

    expect(deps.removePending).not.toHaveBeenCalled()
    expect(settled).toEqual([])
  })
})
