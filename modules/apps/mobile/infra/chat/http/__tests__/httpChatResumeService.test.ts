import { describe, expect, it } from "vitest"

import type { ChatRequest } from "../chatHttp.js"
import { createHttpChatResumeService } from "../httpChatResumeService.js"

const MESSAGE_ID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301"
const TRACE_ID = "3f2504e04f8911d39a0c0305e82c3301"

interface Harness {
  readonly service: ReturnType<typeof createHttpChatResumeService>
  readonly calls: Array<{ path: string; method: string | undefined }>
}

function makeHarness(respond: () => Response): Harness {
  const calls: Array<{ path: string; method: string | undefined }> = []
  const request: ChatRequest = async (path, init) => {
    calls.push({ path, method: init?.method })
    return respond()
  }
  return {
    calls,
    service: createHttpChatResumeService({ request, getAccessToken: async () => "token-1" }),
  }
}

const turn = (state: string, events: unknown[]): Response =>
  new Response(JSON.stringify({ state, events }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })

describe("createHttpChatResumeService", () => {
  it("hands the store typed events, not wire frames", async () => {
    const h = makeHarness(() =>
      turn("done", [
        { event: "delta", data: JSON.stringify({ text: "The soul " }) },
        { event: "delta", data: JSON.stringify({ text: "is eternal." }) },
      ])
    )

    const resumed = await h.service.getTurn(MESSAGE_ID)

    expect(resumed?.state).toBe("done")
    expect(resumed?.events).toEqual([
      { type: "delta", text: "The soul " },
      { type: "delta", text: "is eternal." },
    ])
  })

  it("skips a frame the wire contract does not describe instead of failing the resume", async () => {
    const h = makeHarness(() =>
      turn("done", [
        { event: "telemetry", data: "{}" },
        { event: "delta", data: JSON.stringify({ text: "kept" }) },
      ])
    )

    expect((await h.service.getTurn(MESSAGE_ID))?.events).toEqual([{ type: "delta", text: "kept" }])
  })

  it("reports a turn still generating so the caller polls again", async () => {
    const h = makeHarness(() => turn("running", []))

    expect(await h.service.getTurn(MESSAGE_ID)).toEqual({ state: "running", events: [] })
  })

  it("returns null when the server no longer has the turn", async () => {
    const h = makeHarness(() => new Response(null, { status: 404 }))

    expect(await h.service.getTurn(MESSAGE_ID)).toBeNull()
  })

  it("cancels the turn by its trace id", async () => {
    const h = makeHarness(() => new Response(null, { status: 204 }))

    await h.service.cancelTurn(MESSAGE_ID)

    expect(h.calls).toEqual([{ path: `/chat/turn/${TRACE_ID}`, method: "DELETE" }])
  })
})
