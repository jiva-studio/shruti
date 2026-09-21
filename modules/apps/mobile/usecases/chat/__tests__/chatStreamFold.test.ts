import { describe, expect, it } from "vitest"
import type { ChatActionPayload, ChatStreamEvent } from "@lib/contracts"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import { createTurnCards } from "../chatActionFold.js"
import { createFoldState, foldChatStream } from "../chatStreamFold.js"
import type { RunChatTurnEvent } from "../chatTurnEvents.js"
import { streamErrorEvent } from "../chatTurnError.js"

/** A frame the contracts do not describe — what a newer server, or a server
 *  bug, can put on the wire. The guards under test exist for exactly this,
 *  so the tests must be able to send it. */
function offContract(value: unknown): ChatStreamEvent {
  return value as ChatStreamEvent
}

async function* from(...events: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const e of events) yield e
}

async function drain(
  source: AsyncIterable<ChatStreamEvent>,
  signal = new AbortController().signal
) {
  const cards = createTurnCards()
  const state = createFoldState()
  const out: RunChatTurnEvent[] = []
  for await (const e of foldChatStream(source, cards, state, signal)) out.push(e)
  return { out, cards, state }
}

const delta = (text: string): ChatStreamEvent => ({ type: "delta", text })

const outlineAction: ChatActionPayload = {
  kind: "outline",
  id: "a1",
  payload: { trackId: "t1", items: [{ startMs: 0, title: "Intro" }] },
}
const outline: ChatStreamEvent = { type: "action", payload: outlineAction }

describe("foldChatStream", () => {
  it("accumulates the prose and forwards each delta", async () => {
    const { out, state } = await drain(from(delta("Hare "), delta("Krishna")))
    expect(state.acc).toBe("Hare Krishna")
    expect(out).toEqual([
      { kind: "delta", text: "Hare " },
      { kind: "delta", text: "Krishna" },
    ])
  })

  it("throws away the first pass when a tool re-runs", async () => {
    const { out, cards, state } = await drain(
      from(delta("first pass"), outline, { type: "tool_start" }, delta("second"))
    )
    expect(state.acc).toBe("second")
    expect(cards.outlines).toEqual({})
    expect(out.some((e) => e.kind === "tool-start")).toBe(true)
  })

  it("stashes a folded action in its slot and announces it", async () => {
    const { out, cards } = await drain(from(outline))
    expect(Object.keys(cards.outlines)).toHaveLength(1)
    expect(out).toHaveLength(1)
  })

  it("drops a malformed action instead of crashing the bubble", async () => {
    const { out, cards } = await drain(
      from(offContract({ type: "action", payload: { kind: "nonsense", id: "a1", payload: {} } }))
    )
    expect(out).toEqual([])
    expect(cards).toEqual(createTurnCards())
  })

  it("records done, with the aliases and attributes the next turn sends back", async () => {
    const { state } = await drain(
      from({
        type: "done",
        aliases: { "1": { track_id: "t1", start_ms: 10, end_ms: 20 } },
        attributes: { reply_language: { value: "en", label: "Language", explicit: true } },
      })
    )
    expect(state.sawDone).toBe(true)
    expect(state.aliases).toEqual({ "1": { trackId: "t1", startMs: 10, endMs: 20 } })
    expect(state.attributes).toEqual({
      reply_language: { value: "en", label: "Language", explicit: true },
    })
  })

  it("records an error with every field the server sent", async () => {
    const { state } = await drain(
      from({
        type: "error",
        code: "rate_limited",
        message: "slow down",
        retryAfter: 30,
        tier: "free",
        resetsAtEpoch: 1700,
        current: 5,
        limit: 5,
        keyType: "user",
      })
    )
    expect(state.lastError).toMatchObject({ code: "rate_limited", retryAfter: 30, limit: 5 })
    expect(state.sawTurnsLimit).toBe(false)
  })

  it("flags the turn limit so the caller can say so rather than retry", async () => {
    const { state } = await drain(
      from({ type: "error", code: "max_turns_exceeded", message: "enough" })
    )
    expect(state.sawTurnsLimit).toBe(true)
  })

  it("forwards the progress frames nothing persists", async () => {
    const { out, state } = await drain(
      from(
        { type: "status", key: "searching", params: { n: 1 } },
        { type: "research_question", question: "what is bhakti?" },
        { type: "research_source", sourceKind: "lecture_chunk", id: "t1", label: "A lecture" },
        { type: "usage", scope: "daily", current: 3, limit: 10, resetsAtEpoch: 1700 }
      )
    )
    expect(out.map((e) => e.kind)).toEqual([
      "status",
      "research-question",
      "research-source",
      "usage",
    ])
    expect(state.acc).toBe("")
    expect(state.sawDone).toBe(false)
  })

  it("ignores a frame this build does not know", async () => {
    const { out } = await drain(from(offContract({ type: "from_the_future" })))
    expect(out).toEqual([])
  })

  it("turns a transport failure into a retryable stream error", async () => {
    async function* boom(): AsyncIterable<ChatStreamEvent> {
      yield delta("partial")
      throw new Error("socket died")
    }
    const { out, state } = await drain(boom())
    expect(out).toEqual([{ kind: "delta", text: "partial" }])
    expect(state.lastError).toEqual({ code: "stream", message: "socket died" })
  })

  it.each([
    ["a protocol mismatch", () => new ProtocolVersionMismatchError([2], 1)],
    ["an unavailable backend", () => new BackendUnavailableError()],
  ])("rethrows %s rather than offering a retry", async (_label, make) => {
    async function* boom(): AsyncIterable<ChatStreamEvent> {
      yield delta("x")
      throw make()
    }
    await expect(drain(boom())).rejects.toThrow()
  })

  it("stops reading once the turn is aborted", async () => {
    const controller = new AbortController()
    let pulled = 0
    async function* endless(): AsyncIterable<ChatStreamEvent> {
      for (;;) {
        pulled++
        if (pulled === 2) controller.abort()
        yield delta("x")
      }
    }
    const { out } = await drain(endless(), controller.signal)
    expect(out).toHaveLength(1)
  })
})

describe("streamErrorEvent", () => {
  it("keeps an absent optional field absent", () => {
    const e = streamErrorEvent({ code: "stream", message: "died" })
    expect(Object.keys(e).sort()).toEqual(["code", "message", "retryAfter"])
    expect(e.retryAfter).toBeUndefined()
  })

  it("carries every field the server did send", () => {
    expect(
      streamErrorEvent({
        code: "rate_limited",
        message: "slow",
        retryAfter: 30,
        tier: "free",
        resetsAtEpoch: 1700,
        current: 5,
        limit: 5,
        keyType: "ip",
      })
    ).toEqual({
      code: "rate_limited",
      message: "slow",
      retryAfter: 30,
      tier: "free",
      resetsAtEpoch: 1700,
      current: 5,
      limit: 5,
      keyType: "ip",
    })
  })
})
