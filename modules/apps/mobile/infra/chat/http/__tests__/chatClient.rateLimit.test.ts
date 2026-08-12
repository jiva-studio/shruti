import { afterEach, describe, expect, it, vi } from "vitest"
import type { ChatStreamEvent } from "@lib/contracts"
import { streamChat } from "../chatClient.js"

/**
 * The transport must not invent a `Retry-After`.
 *
 * It used to: `retryHeader ? Number(retryHeader) : 60`. That made a fabricated
 * 60 indistinguishable from a real header downstream — so once the store began
 * preferring the relative value (the clock-skew fix in #1741/#1742), the made-up
 * constant silently beat the server's own `resets_at_epoch` and locked the
 * composer for 60 s against a 12-second reset.
 *
 * Absence is now reported as absence, and an epoch-only 429 is converted into a
 * wait the SERVER measured, using the response's own `Date` header.
 */

interface RateLimitBody {
  readonly tier?: string
  readonly resets_at_epoch?: number
  readonly current?: number
  readonly limit?: number
  readonly key_type?: string
}

/** A `request` that answers 429 with the given headers + `detail` body. */
function refuses(headers: Record<string, string>, detail: RateLimitBody) {
  const response = {
    ok: false,
    status: 429,
    headers: new Headers(headers),
    clone: () => ({ json: () => Promise.resolve({ detail }) }),
  } as unknown as Response
  return vi.fn(() => Promise.resolve(response))
}

async function collect(
  request: (path: string, init: RequestInit) => Promise<Response>
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of streamChat([{ role: "user", content: "hi" }], "en", {
    request: request as never,
    getAccessToken: () => Promise.resolve("token"),
  })) {
    events.push(event)
  }
  return events
}

/** Epoch seconds of a fixed server instant, and the reset 12 s after it. */
const SERVER_NOW_MS = Date.UTC(2026, 7, 12, 9, 0, 0)
const SERVER_DATE = new Date(SERVER_NOW_MS).toUTCString()
const RESETS_AT_EPOCH = Math.floor(SERVER_NOW_MS / 1000) + 12

const DETAIL: RateLimitBody = {
  tier: "free",
  resets_at_epoch: RESETS_AT_EPOCH,
  current: 5,
  limit: 5,
  key_type: "user",
}

describe("streamChat — a quota 429", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports a missing Retry-After as missing, not as 60", async () => {
    const events = await collect(refuses({}, DETAIL))

    expect(events).toHaveLength(1)
    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.code).toBe("rate_limited")
    // The whole defect in one assertion: a 60 here is a number this layer made
    // up, and downstream it is worth exactly as much as one the server sent.
    expect(event.retryAfter).toBeUndefined()
    // …while the real deadline the server DID send is passed on untouched.
    expect(event.resetsAtEpoch).toBe(RESETS_AT_EPOCH)
  })

  it("passes a real Retry-After through", async () => {
    const events = await collect(refuses({ "Retry-After": "12" }, DETAIL))

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.retryAfter).toBe(12)
  })

  it("derives the wait from resets_at_epoch against the response Date", async () => {
    // The device clock is a day slow — and must not enter the arithmetic. Both
    // ends of the subtraction are server readings, so the answer is 12 either
    // way.
    vi.useFakeTimers()
    vi.setSystemTime(SERVER_NOW_MS - 24 * 60 * 60 * 1000)

    const events = await collect(refuses({ Date: SERVER_DATE }, DETAIL))

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.retryAfter).toBe(12)
  })

  it("prefers the header over the Date-derived wait when both are available", async () => {
    const events = await collect(refuses({ "Retry-After": "30", Date: SERVER_DATE }, DETAIL))

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.retryAfter).toBe(30)
  })

  it("treats an unusable Retry-After as absent rather than as 60", async () => {
    // The RFC's HTTP-date form. Reading it needs a clock, which is what this
    // value exists to avoid — so it falls through to the `Date` derivation.
    const events = await collect(refuses({ "Retry-After": SERVER_DATE, Date: SERVER_DATE }, DETAIL))

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.retryAfter).toBe(12)
  })

  it("omits the wait entirely when a Date is present but the reset has passed", async () => {
    const events = await collect(
      refuses(
        { Date: SERVER_DATE },
        { ...DETAIL, resets_at_epoch: Math.floor(SERVER_NOW_MS / 1000) - 5 }
      )
    )

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.retryAfter).toBeUndefined()
  })

  it("carries no wait at all for a bare 429", async () => {
    const events = await collect(refuses({}, {}))

    const [event] = events as [Extract<ChatStreamEvent, { type: "error" }>]
    expect(event.code).toBe("rate_limited")
    expect(event.retryAfter).toBeUndefined()
    expect(event.resetsAtEpoch).toBeUndefined()
  })
})
