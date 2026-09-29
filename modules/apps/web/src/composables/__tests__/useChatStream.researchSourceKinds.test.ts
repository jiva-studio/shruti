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

function newChat() {
  return useChatStream({ chatBase: "https://chat.test", lang: "en", freeTurns: 10, onScroll: () => undefined })
}

describe("useChatStream research sources", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("shows the commentary and media research sources the server emits", async () => {
    const body =
      sse("research_source", { kind: "commentary", id: "library:1", label: "Purport" }) +
      sse("research_source", { kind: "media", id: "media:2", label: "Video" }) +
      sse("done", {})
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode(body), { status: 200 })))
    const chat = newChat()

    await chat.send("q")

    expect([...chat.messages.value[1]!.researchSources!.keys()]).toEqual(["library:1", "media:2"])
  })
})
