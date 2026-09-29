import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatStream } from "../useChatStream"

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    getToken: () => "jwt",
    ensureToken: async () => "jwt",
    resetToken: () => undefined,
  }),
}))

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamOnce(body: string) {
  const fetchMock = vi.fn(async () => new Response(new TextEncoder().encode(body), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function newChat() {
  return useChatStream({
    chatBase: "https://chat.test",
    lang: "en",
    freeTurns: 10,
    onScroll: () => undefined,
  })
}

describe("useChatStream wire edges", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("does not cap the user on a usage frame from a limiter that reports no limit", async () => {
    streamOnce(
      sse("usage", {
        scope: "chat",
        current: 0,
        limit: 0,
        resets_at_epoch: 1_900_000_000,
      }) +
        sse("delta", { text: "hi" }) +
        sse("done", {})
    )
    const chat = newChat()

    await chat.send("q")

    expect(chat.srvLimit.value).toBeNull()
    expect(chat.capped.value).toBe(false)
  })

  it("hydrates the server limit from a complete usage frame", async () => {
    streamOnce(
      sse("usage", {
        scope: "chat",
        current: 3,
        limit: 10,
        resets_at_epoch: 1_900_000_000,
      }) + sse("done", {})
    )
    const chat = newChat()

    await chat.send("q")

    expect(chat.srvLimit.value).toBe(10)
    expect(chat.srvCurrent.value).toBe(3)
    expect(chat.left.value).toBe(7)
  })

  it("reads CRLF-framed events like LF-framed ones", async () => {
    const crlf = (event: string, data: unknown) =>
      `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
    const fetchMock = streamOnce(
      crlf("delta", { text: "Hel" }) + crlf("delta", { text: "lo" }) + crlf("done", {})
    )
    const chat = newChat()

    await chat.send("q")

    expect(chat.messages.value[1]).toMatchObject({
      role: "assistant",
      text: "Hello",
    })
    expect(chat.failed.value).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps a known research source and skips one with no id", async () => {
    streamOnce(
      sse("research_source", {
        kind: "verse",
        id: "bg:2.13",
        label: "BG 2.13",
      }) +
        sse("research_source", { kind: "verse", id: "  ", label: "blank" }) +
        sse("done", {})
    )
    const chat = newChat()

    await chat.send("q")

    const sources = chat.messages.value[1]!.researchSources!
    expect([...sources.keys()]).toEqual(["bg:2.13"])
  })
})
