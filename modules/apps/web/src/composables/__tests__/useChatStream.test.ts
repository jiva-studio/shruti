import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { CHAT_HISTORY_WINDOW } from "@lib/chat/stream/chatRequestBody.js"
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
  payload: { source_id: "bg", tokens: "2.13", addr_label: "BG 2.13" },
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

describe("useChatStream track context", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the current track on every send, not the one it was created with", async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        const done = sse("delta", { text: "ok" }) + sse("done", {})
        return new Response(new TextEncoder().encode(done), { status: 200 })
      })
    )
    const trackId = ref<string | undefined>("track-a")
    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "en",
      trackId: () => trackId.value,
      freeTurns: 10,
      onScroll: () => undefined,
    })

    await chat.send("first")
    trackId.value = "track-b"
    await chat.send("second")
    trackId.value = undefined
    await chat.send("third")

    expect(bodies.map((b) => b.user_context)).toEqual([
      { current_track_id: "track-a" },
      { current_track_id: "track-b" },
      undefined,
    ])
  })
})

describe("useChatStream history window", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends at most the last CHAT_HISTORY_WINDOW turns, ending with the new prompt", async () => {
    const bodies: {
      messages: { role: string; content: string }[]
      attributes?: unknown
    }[] = []
    let turn = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number])
        const attributes =
          turn++ === 0 ? { reply_language: { value: "ru", explicit: true } } : undefined
        const done = sse("delta", { text: `a${turn}` }) + sse("done", { attributes })
        return new Response(new TextEncoder().encode(done), { status: 200 })
      })
    )
    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "en",
      freeTurns: 100,
      onScroll: () => undefined,
    })

    for (let i = 0; i < 12; i++) await chat.send(`q${i}`)

    const last = bodies[bodies.length - 1]!
    expect(last.messages).toHaveLength(CHAT_HISTORY_WINDOW)
    expect(last.messages[last.messages.length - 1]).toEqual({
      role: "user",
      content: "q11",
    })
    expect(last.messages[0]).toMatchObject({
      role: "assistant",
      content: "a2",
    })
    // The first turn's attribute has left the window but still rides in the aggregate.
    expect(last.attributes).toMatchObject({
      reply_language: { value: "ru", explicit: true },
    })
  })
})
