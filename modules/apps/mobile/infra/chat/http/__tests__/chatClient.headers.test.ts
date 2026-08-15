import { describe, expect, it, vi, afterEach } from "vitest"
import type { ChatStreamEvent } from "@lib/contracts"
import { CHAT_HEADERS_TIMEOUT_MS, streamChat } from "../chatClient.js"

/**
 * Issue #1614 item 3: only the post-header reads were bounded (#1547). The
 * `POST /chat` itself was awaited bare, and `fetch` has no default timeout —
 * an edge that completes the handshake and then never writes a status line
 * left `sendMessage`'s `for await` parked forever. Its `finally` never ran, so
 * `turnControllers` kept the turn's AbortController and `syncComposeBusy` went
 * on reporting `sending = true`: a dead composer until the app was relaunched.
 *
 * Every test here HANGS against the unfixed client — the deadline is what
 * makes the generator terminate at all.
 */

const encoder = new TextEncoder()

/** A `request` that accepts the connection and never answers. */
function neverAnswers() {
  const signals: (AbortSignal | undefined | null)[] = []
  const fn = vi.fn((_path: string, init: RequestInit) => {
    signals.push(init.signal)
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError"))
      )
    })
  })
  return { fn, signals }
}

/** A `request` that hangs on the first call and streams on the second. */
function hangsThenStreams(body: string) {
  let call = 0
  return vi.fn((_path: string, init: RequestInit) => {
    call += 1
    if (call === 1) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      })
    }
    let sent = false
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => {
            if (sent) return Promise.resolve({ done: true, value: undefined })
            sent = true
            return Promise.resolve({ done: false, value: encoder.encode(body) })
          },
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response)
  })
}

async function collect(
  request: (path: string, init: RequestInit) => Promise<Response>,
  advanceMs: number,
  signal?: AbortSignal
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  const done = (async () => {
    for await (const event of streamChat([{ role: "user", content: "hi" }], "en", {
      request: request as never,
      getAccessToken: () => Promise.resolve("token"),
      ...(signal ? { signal } : {}),
    })) {
      events.push(event)
    }
  })()
  await vi.advanceTimersByTimeAsync(advanceMs)
  await done
  return events
}

describe("streamChat — POST /chat header deadline", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("gives up on a server that never sends response headers", async () => {
    vi.useFakeTimers()
    const { fn } = neverAnswers()

    // Three attempts (the existing transient-retry loop) plus its backoff.
    const events = await collect(fn, CHAT_HEADERS_TIMEOUT_MS * 3 + 5_000)

    // Reaching ANY terminal event is what lets the generator's `finally`
    // release the turn's AbortController. The code is `server_unreachable`,
    // not `network`: a server that accepted the connection and then never
    // sent headers is not the user's internet, and `network` is the one code
    // that arms the reconnect auto-resend (#1843).
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "error", code: "server_unreachable" })
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("aborts the hung request instead of leaving the socket open", async () => {
    vi.useFakeTimers()
    const { fn, signals } = neverAnswers()

    await collect(fn, CHAT_HEADERS_TIMEOUT_MS * 3 + 5_000)

    // Racing the await would resolve the caller and leak one connection per
    // attempt; the deadline has to reach the request itself.
    expect(signals).toHaveLength(3)
    for (const s of signals) expect(s?.aborted).toBe(true)
  })

  it("re-dials after a hang and streams the retry normally", async () => {
    vi.useFakeTimers()
    const request = hangsThenStreams(`event: delta\ndata: {"text":"Hare"}\n\n`)

    const events = await collect(request, CHAT_HEADERS_TIMEOUT_MS + 5_000)

    // A headers hang is a transient network failure, not a hard stop — the
    // second attempt must be allowed to succeed.
    expect(events).toEqual([{ type: "delta", text: "Hare" }])
  })

  it("does not disarm the caller's Stop — an abort still ends the turn", async () => {
    vi.useFakeTimers()
    const { fn, signals } = neverAnswers()
    const caller = new AbortController()

    const events = await (async () => {
      const collected = collect(fn, 1_000, caller.signal)
      await vi.advanceTimersByTimeAsync(10)
      caller.abort()
      return collected
    })()

    // The attempt controller is bridged to the caller's signal, so Stop still
    // reaches the request — and the client reports nothing (the store owns the
    // cancelled-turn UI), well before the deadline would have fired.
    expect(signals[0]?.aborted).toBe(true)
    expect(events).toEqual([])
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
