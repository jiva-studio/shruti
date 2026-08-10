import { describe, expect, it, vi, afterEach } from "vitest"
import type { ChatStreamEvent } from "@lib/contracts"
import { SSE_STALL_TIMEOUT_MS, streamChat } from "../chatClient.js"

/**
 * Issue #1503: the SSE read loop had no deadline, so a half-open socket (NAT
 * dropped the flow, the radio changed) left the turn spinning until the user
 * navigated away. The stall window turns that silence into the `code: "stream"`
 * error the store already reads as a resumable drop, so the turn recovers in
 * place.
 */

const encoder = new TextEncoder()

function frame(event: string, data: string): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${data}\n\n`)
}

/** A reader that delivers `chunks`, then goes silent — for `endAfterMs` if
 *  given (a slow but live connection), forever otherwise (a half-open one). */
function silentAfter(chunks: Uint8Array[], endAfterMs?: number) {
  let i = 0
  return {
    read: vi.fn(() => {
      if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] })
      if (endAfterMs === undefined) return new Promise<never>(() => {})
      return new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), endAfterMs)
      )
    }),
    cancel: vi.fn(() => Promise.resolve()),
  }
}

function respondWith(reader: ReturnType<typeof silentAfter>) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response)
  )
}

async function collect(reader: ReturnType<typeof silentAfter>, advanceMs: number) {
  const events: ChatStreamEvent[] = []
  const done = (async () => {
    for await (const event of streamChat([{ role: "user", content: "hi" }], "en", {
      request: respondWith(reader),
      getAccessToken: () => Promise.resolve("token"),
    })) {
      events.push(event)
    }
  })()
  await vi.advanceTimersByTimeAsync(advanceMs)
  await done
  return events
}

describe("streamChat — stall timeout", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fails a silent stream as a resumable drop once the window elapses", async () => {
    vi.useFakeTimers()
    const reader = silentAfter([frame("delta", "Hare")])

    const events = await collect(reader, SSE_STALL_TIMEOUT_MS)

    expect(events).toEqual([
      { type: "delta", text: "Hare" },
      // `code: "stream"` is load-bearing: useChatStore reads it as a dropped
      // connection, keeps the thinking placeholder and resumes the buffered
      // turn instead of showing a failed bubble.
      { type: "error", code: "stream", message: `SSE stalled: no data for 45000ms` },
    ])
    // The socket is let go, not left half-open behind us.
    expect(reader.cancel).toHaveBeenCalledOnce()
  })

  it("keeps waiting while the connection is merely slow", async () => {
    vi.useFakeTimers()
    // A long tool call: nothing but silence for one second short of the
    // window, then the server closes its side normally.
    const reader = silentAfter([frame("delta", "Hare")], SSE_STALL_TIMEOUT_MS - 1000)

    const events = await collect(reader, SSE_STALL_TIMEOUT_MS)

    expect(events).toEqual([{ type: "delta", text: "Hare" }])
  })

  it("restarts the window on every byte, keepalive comments included", async () => {
    vi.useFakeTimers()
    // sse-starlette's `ping=15` heartbeat is a comment frame carrying no
    // event of its own. It still has to hold the connection open — three of
    // them span more than the stall window.
    const reader = silentAfter([
      frame("delta", "Hare"),
      encoder.encode(": ping\n\n"),
      encoder.encode(": ping\n\n"),
      frame("delta", "Krishna"),
    ])

    const events = await collect(reader, SSE_STALL_TIMEOUT_MS * 2)

    const texts = events.flatMap((e) => (e.type === "delta" && e.text !== "" ? [e.text] : []))
    expect(texts).toEqual(["Hare", "Krishna"])
    // …and the window still fires once the stream really does go quiet.
    expect(events[events.length - 1]).toMatchObject({ type: "error", code: "stream" })
  })
})
