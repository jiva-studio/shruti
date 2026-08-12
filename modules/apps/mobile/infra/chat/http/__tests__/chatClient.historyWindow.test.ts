import { describe, expect, it, vi } from "vitest"
import type { ChatTurn } from "@lib/contracts"
import { CHAT_HISTORY_WINDOW, streamChat } from "../chatClient.js"

/**
 * Issue #1771: `ChatRequestDto.messages` is `max_length=20` and pydantic
 * REJECTS a longer list — it does not truncate, despite what the comments on
 * both sides used to claim. The client shipped its entire local history, so a
 * conversation was permanently unsendable from its 21st message on: every send
 * came back 422, which is not a transient status, so the user got the generic
 * error bubble and Retry re-sent the same oversized body.
 *
 * The window is applied in the transport, not in the store or the use case,
 * because it is a fact about the wire contract — and because the request-level
 * `attributes` aggregate must keep folding the FULL history, which only holds
 * if the slice happens after the fold. These tests pin both halves.
 */

interface RequestBody {
  readonly messages: { readonly role: string; readonly content: string }[]
  readonly attributes?: Record<string, { value: string | string[]; explicit: boolean }>
}

/** A `request` that captures the JSON body and answers an empty 200 stream. */
function captures() {
  const bodies: RequestBody[] = []
  const fn = vi.fn((_path: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as RequestBody)
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response)
  })
  return { fn, bodies }
}

async function send(request: ReturnType<typeof captures>["fn"], turns: readonly ChatTurn[]) {
  const stream = streamChat(turns, "en", {
    request: request as never,
    getAccessToken: () => Promise.resolve("token"),
  })
  // Drain: the body is only sent once the generator is iterated.
  for await (const event of stream) void event
}

/** `n` alternating turns, contents "m0".."m{n-1}" — oldest first. */
function history(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `m${i}`,
  }))
}

describe("chat history window", () => {
  it("sends a short history untouched", async () => {
    const { fn, bodies } = captures()
    await send(fn, history(6))
    expect(bodies[0]?.messages).toHaveLength(6)
    expect(bodies[0]?.messages[0]?.content).toBe("m0")
  })

  it("sends exactly the server's maximum at the boundary", async () => {
    const { fn, bodies } = captures()
    await send(fn, history(CHAT_HISTORY_WINDOW))
    expect(bodies[0]?.messages).toHaveLength(CHAT_HISTORY_WINDOW)
    expect(bodies[0]?.messages[0]?.content).toBe("m0")
  })

  it.each([CHAT_HISTORY_WINDOW + 1, 47, 500])(
    "never exceeds the window with %i local messages",
    async (n) => {
      const { fn, bodies } = captures()
      await send(fn, history(n))
      expect(bodies[0]?.messages).toHaveLength(CHAT_HISTORY_WINDOW)
    }
  )

  it("keeps the NEWEST turns, in order", async () => {
    const { fn, bodies } = captures()
    const n = 45
    await send(fn, history(n))
    const sent = bodies[0]?.messages ?? []
    // The last message is the question being asked — dropping the tail instead
    // of the head would send the server somebody else's turn.
    expect(sent[sent.length - 1]?.content).toBe(`m${n - 1}`)
    expect(sent[0]?.content).toBe(`m${n - CHAT_HISTORY_WINDOW}`)
    expect(sent.map((m) => m.content)).toEqual(
      history(n)
        .slice(-CHAT_HISTORY_WINDOW)
        .map((m) => m.content)
    )
  })

  it("keeps an attribute settled before the window in the request aggregate", async () => {
    const { fn, bodies } = captures()
    const turns: ChatTurn[] = [
      { role: "user", content: "отвечай по-русски" },
      {
        role: "assistant",
        content: "хорошо",
        attributes: { reply_language: { value: "ru", label: "Русский", explicit: true } },
      },
      ...history(60),
    ]
    await send(fn, turns)
    // The message that carried it fell out of the window...
    expect(bodies[0]?.messages).toHaveLength(CHAT_HISTORY_WINDOW)
    expect(bodies[0]?.messages.some((m) => m.content === "хорошо")).toBe(false)
    // ...but the aggregate, folded over the full local history, still has it.
    expect(bodies[0]?.attributes?.reply_language).toEqual({
      value: "ru",
      label: "Русский",
      explicit: true,
    })
  })
})
