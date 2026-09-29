import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatStream } from "../useChatStream"

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    getToken: () => "jwt",
    ensureToken: async () => "jwt",
    resetToken: () => undefined,
  }),
}))

describe("useChatStream stop()", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("logs a failed server-side cancel with the trace id and still aborts locally", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const cancelError = new TypeError("Failed to fetch")
    let postSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.reject(cancelError)
      postSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        postSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        )
      })
    })
    vi.stubGlobal("fetch", fetchMock)
    const chat = useChatStream({
      chatBase: "https://chat.test",
      lang: "en",
      freeTurns: 10,
      onScroll: () => undefined,
    })

    const sending = chat.send("q")
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const traceId = chat.messages.value[1]!.traceId!
    chat.stop()
    await sending
    await new Promise((r) => setTimeout(r, 0))

    expect(postSignal?.aborted).toBe(true)
    const logged = warn.mock.calls.find((args) => args.includes(cancelError))
    expect(logged).toBeDefined()
    expect(logged!.map(String).join(" ")).toContain(traceId)
  })
})
