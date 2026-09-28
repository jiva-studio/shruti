import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChatStream } from "../useChatStream"

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    getToken: () => "jwt",
    ensureToken: async () => "jwt",
    resetToken: () => undefined,
  }),
}))

const VERSE_ACTION = {
  kind: "verse",
  id: "v1",
  payload: { source_id: 1, tokens: "2.13", addr_label: "BG 2.13" },
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A stream that delivers `chunks` and then drops the connection. */
function droppedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const queue = [...chunks]
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift()
      if (next === undefined) controller.error(new Error("socket dropped"))
      else controller.enqueue(enc.encode(next))
    },
  })
}

describe("useChatStream resume", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("replays the server buffer onto a clean bubble, not onto the partial one", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          droppedStream([
            sse("research_question", { question: "q1" }),
            sse("action", VERSE_ACTION),
            sse("delta", { text: "Hel" }),
          ]),
          { status: 200 }
        )
      }
      expect(url).toContain("/chat/turn/")
      return new Response(
        JSON.stringify({
          state: "done",
          events: [
            { event: "research_question", data: { question: "q1" } },
            { event: "action", data: VERSE_ACTION },
            { event: "delta", data: { text: "Hel" } },
            { event: "delta", data: { text: "lo" } },
            { event: "done", data: {} },
          ],
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "en",
      freeTurns: 10,
      onScroll: () => undefined,
    })
    const sending = chat.send("question")
    await vi.runAllTimersAsync()
    await sending

    const answer = chat.messages.value[1]!
    expect(chat.failed.value).toBe(false)
    expect(answer.streaming).toBe(false)
    expect(answer.text).toBe("Hello")
    expect(answer.researchQuestions).toEqual(["q1"])
    expect(answer.verses?.size).toBe(1)
    expect(answer.traceId).toMatch(/^[0-9a-f]{32}$/)
  })

  it("replays each poll of the buffer from scratch", async () => {
    const polls = [
      {
        state: "running",
        events: [{ event: "delta", data: { text: "Hel" } }],
      },
      {
        state: "done",
        events: [
          { event: "research_question", data: { question: "q1" } },
          { event: "delta", data: { text: "Hel" } },
          { event: "delta", data: { text: "lo" } },
          { event: "done", data: {} },
        ],
      },
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(droppedStream([sse("research_question", { question: "q1" })]), {
            status: 200,
          })
        }
        return new Response(JSON.stringify(polls.shift()), { status: 200 })
      })
    )

    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "en",
      freeTurns: 10,
      onScroll: () => undefined,
    })
    const sending = chat.send("question")
    await vi.runAllTimersAsync()
    await sending

    const answer = chat.messages.value[1]!
    expect(answer.text).toBe("Hello")
    expect(answer.researchQuestions).toEqual(["q1"])
  })
})
