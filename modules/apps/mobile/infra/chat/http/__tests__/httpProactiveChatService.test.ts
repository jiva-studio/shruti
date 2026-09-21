import { describe, expect, it } from "vitest"

import type { ProactiveTurnRequest } from "@lib/contracts"

import type { ChatRequest } from "../chatHttp.js"
import { createHttpProactiveChatService } from "../httpProactiveChatService.js"

const REQUEST: ProactiveTurnRequest = {
  ruleKind: "weekly_digest",
  ruleDate: "2026-09-21",
  ruleContext: { tracks: 3 },
}

interface Frame {
  event: string
  data: unknown
}

const sseBody = (frames: readonly Frame[]): string =>
  frames
    .map(
      (f) =>
        `event: ${f.event}\ndata: ${typeof f.data === "string" ? f.data : JSON.stringify(f.data)}\n\n`
    )
    .join("")

interface Harness {
  readonly service: ReturnType<typeof createHttpProactiveChatService>
  readonly bodies: Array<Record<string, unknown>>
}

function makeHarness(frames: readonly Frame[]): Harness {
  const bodies: Array<Record<string, unknown>> = []
  const request: ChatRequest = async (_path, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(sseBody(frames), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  }
  return {
    bodies,
    service: createHttpProactiveChatService({ request, getAccessToken: async () => "token-1" }),
  }
}

describe("createHttpProactiveChatService", () => {
  it("collapses the stream into one markdown body", async () => {
    const h = makeHarness([
      { event: "delta", data: { text: "This week " } },
      { event: "delta", data: { text: "you listened to 3 lectures." } },
      { event: "done", data: {} },
    ])

    expect(await h.service.run(REQUEST, "en")).toEqual({
      bodyMd: "This week you listened to 3 lectures.",
      actions: {},
    })
  })

  it("keys each action card by the id its marker carries", async () => {
    const h = makeHarness([
      { event: "delta", data: { text: "See " } },
      {
        event: "action",
        data: {
          kind: "verse",
          id: "a1",
          payload: { source_id: "bg", tokens: "2.13", addr_label: "BG 2.13" },
        },
      },
      { event: "done", data: {} },
    ])

    const result = await h.service.run(REQUEST, "en")

    expect(Object.keys(result.actions)).toEqual(["a1"])
    expect(result.actions.a1).toMatchObject({ id: "a1", kind: "verse" })
  })

  it("stops reading at done and ignores what the scheduler has no use for", async () => {
    const h = makeHarness([
      { event: "tool_start", data: { name: "search" } },
      { event: "delta", data: { text: "body" } },
      { event: "done", data: {} },
      { event: "delta", data: { text: " trailing" } },
    ])

    expect((await h.service.run(REQUEST, "en")).bodyMd).toBe("body")
  })

  it("raises the server's error rather than storing a half-written digest", async () => {
    const h = makeHarness([
      { event: "delta", data: { text: "half" } },
      { event: "error", data: { code: "rate_limited", message: "Too many requests" } },
    ])

    await expect(h.service.run(REQUEST, "en")).rejects.toThrow(/rate_limited — Too many requests/)
  })

  it("reduces an East-Slavic UI locale to the one the backend has prompts for", async () => {
    const h = makeHarness([{ event: "done", data: {} }])

    await h.service.run(REQUEST, "uk-UA")

    expect(h.bodies[0].lang).toBe("ru")
  })

  it("reduces every other locale to english", async () => {
    const h = makeHarness([{ event: "done", data: {} }])

    await h.service.run(REQUEST, "zh-CN")

    expect(h.bodies[0].lang).toBe("en")
  })

  it("sends the rule the backend picks its prompt by", async () => {
    const h = makeHarness([{ event: "done", data: {} }])

    await h.service.run(REQUEST, "en")

    expect(h.bodies[0].proactive).toEqual({
      rule_kind: "weekly_digest",
      rule_date: "2026-09-21",
      rule_context: { tracks: 3 },
    })
  })

  it("reports an empty body when the model produced no text", async () => {
    const h = makeHarness([{ event: "done", data: {} }])

    expect(await h.service.run(REQUEST, "en")).toEqual({ bodyMd: "", actions: {} })
  })
})
