import { describe, expect, it } from "vitest"

import type { AccessTokenProvider, ChatRequest } from "../chatHttp.js"
import { cancelTurn, getTurn, parseStoredFrame } from "../chatResume.js"

const MESSAGE_ID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
const TRACE_ID = "3f2504e04f8911d39a0c0305e82c3301"

interface Call {
  path: string
  method: string | undefined
  authorization: string | undefined
}

interface Harness {
  readonly request: ChatRequest
  readonly getAccessToken: AccessTokenProvider
  readonly calls: Call[]
}

function makeHarness(
  respond: (path: string) => Response | Promise<Response>,
  token: string | null = "token-1"
): Harness {
  const calls: Call[] = []
  return {
    calls,
    getAccessToken: async () => token,
    request: async (path, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ path, method: init?.method, authorization: headers.Authorization })
      return respond(path)
    },
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

describe("getTurn", () => {
  it("returns the buffered frames of a finished turn", async () => {
    const h = makeHarness(() =>
      json(200, {
        state: "done",
        events: [
          { event: "delta", data: '{"text":"hi"}' },
          { event: "done", data: "{}" },
        ],
      })
    )

    const turn = await getTurn(MESSAGE_ID, h)

    expect(turn).toEqual({
      state: "done",
      events: [
        { event: "delta", data: '{"text":"hi"}' },
        { event: "done", data: "{}" },
      ],
    })
  })

  it("addresses the turn by the hyphenless lowercase trace id", async () => {
    const h = makeHarness(() => json(200, { state: "done", events: [] }))

    await getTurn(MESSAGE_ID, h)

    expect(h.calls[0]).toEqual({
      path: `/chat/turn/${TRACE_ID}`,
      method: "GET",
      authorization: "Bearer token-1",
    })
  })

  it("reports a still-generating turn so the caller keeps polling", async () => {
    const h = makeHarness(() => json(200, { state: "running", events: [] }))

    expect((await getTurn(MESSAGE_ID, h))?.state).toBe("running")
  })

  it("treats an unrecognised state as still running rather than finished", async () => {
    const h = makeHarness(() => json(200, { state: "banana", events: [] }))

    // Calling an unknown state "done" would stop the poll on a turn that is
    // still producing text.
    expect((await getTurn(MESSAGE_ID, h))?.state).toBe("running")
  })

  it("carries an error turn through instead of masking it as running", async () => {
    const h = makeHarness(() => json(200, { state: "error", events: [] }))

    expect((await getTurn(MESSAGE_ID, h))?.state).toBe("error")
  })

  it("returns null for a turn the server no longer buffers", async () => {
    const h = makeHarness(() => new Response(null, { status: 404 }))

    expect(await getTurn(MESSAGE_ID, h)).toBeNull()
  })

  it("drops frames that are not a well-formed event/data pair", async () => {
    const h = makeHarness(() =>
      json(200, {
        state: "done",
        events: [
          { event: "delta", data: "ok" },
          { event: "delta" },
          { data: "orphan" },
          null,
          { event: 7, data: "x" },
          "not an object",
        ],
      })
    )

    expect((await getTurn(MESSAGE_ID, h))?.events).toEqual([{ event: "delta", data: "ok" }])
  })

  it("reads a body without an events array as no frames at all", async () => {
    const h = makeHarness(() => json(200, { state: "done" }))

    expect((await getTurn(MESSAGE_ID, h))?.events).toEqual([])
  })

  it("raises the server's message on a failure the caller must see", async () => {
    const h = makeHarness(() => new Response("upstream is down", { status: 503 }))

    await expect(getTurn(MESSAGE_ID, h)).rejects.toThrow(/503 upstream is down/)
  })

  it("refuses to ask for a turn it has no token to prove it owns", async () => {
    const h = makeHarness(() => json(200, { state: "done", events: [] }), null)

    await expect(getTurn(MESSAGE_ID, h)).rejects.toThrow(/session unrecoverable/)
    expect(h.calls).toHaveLength(0)
  })
})

describe("cancelTurn", () => {
  it("deletes the turn by its trace id", async () => {
    const h = makeHarness(() => new Response(null, { status: 204 }))

    await cancelTurn(MESSAGE_ID, h)

    expect(h.calls[0]).toEqual({
      path: `/chat/turn/${TRACE_ID}`,
      method: "DELETE",
      authorization: "Bearer token-1",
    })
  })

  it("stays silent when the cancel never lands", async () => {
    const h = makeHarness(() => {
      throw new TypeError("Failed to fetch")
    })

    await expect(cancelTurn(MESSAGE_ID, h)).resolves.toBeUndefined()
  })

  it("stays silent when there is no token to cancel with", async () => {
    const h = makeHarness(() => new Response(null, { status: 204 }), null)

    await expect(cancelTurn(MESSAGE_ID, h)).resolves.toBeUndefined()
    expect(h.calls).toHaveLength(0)
  })
})

describe("parseStoredFrame", () => {
  it("rebuilds a replayed frame through the live-stream parser", () => {
    const event = parseStoredFrame({ event: "delta", data: JSON.stringify({ text: "hello" }) })

    expect(event).toMatchObject({ type: "delta", text: "hello" })
  })

  it("returns null for a frame the wire contract does not describe", () => {
    expect(parseStoredFrame({ event: "telemetry", data: "{}" })).toBeNull()
  })
})
