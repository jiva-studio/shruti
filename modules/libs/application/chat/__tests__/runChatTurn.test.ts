import { describe, expect, it } from "vitest"
import { runChatTurn, type RunChatTurnEvent } from "../runChatTurn.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatMessage } from "@lib/domain/chatMessage.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  ChatStreamEvent,
  IChatStreamClient,
  IChatTitleService,
} from "@lib/contracts"

/* --------------------------------------------------------------------- */
/*                                Stubs                                   */
/* --------------------------------------------------------------------- */

function makeMessagesRepo(): IChatMessageRepository {
  const repo: Partial<IChatMessageRepository> = {
    listBySession: async () => [],
    create: async (input) => ({ ...input }) as unknown as ChatMessage,
    updateActionStates: async () => {},
    updateFollowups: async () => {},
    delete: async () => {},
    deleteBySession: async () => {},
    clearAll: async () => {},
    updateFeedback: async () => {},
  }
  return repo as IChatMessageRepository
}

function makeSessionsRepo(): IChatSessionRepository {
  const repo: Partial<IChatSessionRepository> = {
    create: async (input) => ({
      id: input.id,
      title: input.title ?? null,
      createdAt: 0,
      updatedAt: 0,
    }),
    touch: async () => {},
    updateTitle: async () => {},
  }
  return repo as IChatSessionRepository
}

const noopTitle: IChatTitleService = {
  fetchSessionTitle: async () => null,
}

function makeStream(events: readonly ChatStreamEvent[]): IChatStreamClient {
  return {
    async *streamChat() {
      for (const e of events) yield e
    },
  }
}

let idCounter = 0
function idFactory(): ChatMessageId {
  idCounter += 1
  return `msg-${idCounter}` as ChatMessageId
}

async function collect(
  iter: AsyncIterable<RunChatTurnEvent>
): Promise<RunChatTurnEvent[]> {
  const out: RunChatTurnEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

function baseDeps(stream: IChatStreamClient) {
  return {
    sessions: makeSessionsRepo(),
    messages: makeMessagesRepo(),
    stream,
    title: noopTitle,
    buildUserContext: async () => ({}) as never,
    extractFollowups: () => [],
  }
}

function baseInput(signal: AbortSignal) {
  return {
    sessionId: "sess-1" as ChatSessionId,
    text: "hi",
    lang: "en" as const,
    history: [],
    isFirstAssistantTurn: false,
    newMessageId: idFactory,
    signal,
  }
}

/* --------------------------------------------------------------------- */
/*                                Tests                                   */
/* --------------------------------------------------------------------- */

describe("runChatTurn — abort after done (finding #13)", () => {
  it("does NOT relabel a completed answer as stopped when the abort lands after `done`", async () => {
    // The server emits `usage` AFTER the terminal `done`, so the loop
    // reads past `done`. Simulate a user abort firing in that
    // post-terminal window: the stream emits delta + done, then we abort
    // the signal, then a trailing `usage` frame arrives.
    const ctl = new AbortController()
    const stream: IChatStreamClient = {
      async *streamChat() {
        yield { type: "delta", text: "Hello world" } as ChatStreamEvent
        yield { type: "done" } as ChatStreamEvent
        // User taps stop in the gap before the usage frame.
        ctl.abort()
        yield {
          type: "usage",
          scope: "chat",
          current: 1,
          limit: 50,
          resetsAtEpoch: 9999999999,
        } as ChatStreamEvent
      },
    }

    const events = await collect(
      runChatTurn(baseInput(ctl.signal), baseDeps(stream))
    )

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      // The answer completed (sawDone) — the abort in the usage wait
      // must NOT mark it stopped/truncated.
      expect(finalised.message.error).toBeUndefined()
      expect(finalised.message.content).toBe("Hello world")
    }
  })

  it("still marks a genuine pre-done abort as stopped", async () => {
    // Abort BEFORE any `done` — the real user-stop case.
    const ctl = new AbortController()
    const stream: IChatStreamClient = {
      async *streamChat() {
        yield { type: "delta", text: "Partial" } as ChatStreamEvent
        ctl.abort()
        // No `done` — the loop breaks on the aborted signal.
        yield { type: "delta", text: " more" } as ChatStreamEvent
      },
    }

    const events = await collect(
      runChatTurn(baseInput(ctl.signal), baseDeps(stream))
    )

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      expect(finalised.message.error).toEqual({ kind: "stopped" })
    }
  })
})

describe("runChatTurn — tool re-run resets accumulators (finding #12)", () => {
  it("drops actions/outlines emitted before a tool_start re-run", async () => {
    const stream = makeStream([
      // First pass emits an interactive action…
      {
        type: "action",
        payload: {
          kind: "upgrade_to_pro",
          id: "act-1",
          payload: { reason: "x" },
        },
      } as unknown as ChatStreamEvent,
      // …then the agent re-runs a tool, discarding the first pass.
      { type: "tool_start" } as ChatStreamEvent,
      { type: "delta", text: "Final answer" } as ChatStreamEvent,
      { type: "done" } as ChatStreamEvent,
    ])

    const ctl = new AbortController()
    const events = await collect(
      runChatTurn(baseInput(ctl.signal), baseDeps(stream))
    )

    const finalised = events.find((e) => e.kind === "finalised")
    expect(finalised).toBeDefined()
    if (finalised && finalised.kind === "finalised") {
      // The orphaned action from the abandoned pass must not survive.
      expect(finalised.message.actions ?? {}).toEqual({})
      expect(finalised.message.content).toBe("Final answer")
    }
  })
})
