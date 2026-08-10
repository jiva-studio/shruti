import { describe, expect, it, vi } from "vitest"
import { createHttpIngestClient, IngestGatewayError } from "../ingestClient.js"

function client(request: ReturnType<typeof vi.fn>) {
  return createHttpIngestClient({
    getAccessToken: async () => "tok",
    request: request as unknown as (path: string, init?: RequestInit) => Promise<Response>,
  })
}

function ok(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("createHttpIngestClient", () => {
  // Without a timeout a dropped mobile connection hangs until the OS gives up,
  // and the caller's in-flight guard keeps the Add button dead all the while.
  it("bounds every call with an abort signal", async () => {
    const request = vi.fn().mockResolvedValue(ok({ run_id: "r1", membership_id: "m1" }))

    await client(request).submit({ url: "https://youtu.be/2QezV4DhHVo" })

    const init = request.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("surfaces a timed-out request as a typed error", async () => {
    const timeout = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    })
    const request = vi.fn().mockRejectedValue(timeout)

    await expect(client(request).submit({ url: "https://youtu.be/2QezV4DhHVo" })).rejects.toThrow(
      IngestGatewayError
    )
  })

  it("passes a non-timeout failure through untouched", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"))

    await expect(client(request).submit({ url: "https://youtu.be/2QezV4DhHVo" })).rejects.toThrow(
      "offline"
    )
  })
})
