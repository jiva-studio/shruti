import { describe, expect, it, vi } from "vitest"
import type { ChatStreamEvent } from "@lib/contracts"
import { streamChat } from "../chatClient.js"
import { classifyChatTransportFailure } from "../chatTransportFailure.js"

/**
 * Issue #1843: a redeploy or gateway outage was reported as "check your
 * connection". kit's failover client THROWS `Error("HTTP 502")` for exactly
 * 502/503/504, so `streamChat` never saw a response and emitted `network` —
 * the one code that also arms the reconnect auto-resend.
 */

class NetworkErrorLike extends Error {
  override name = "NetworkError"
}

describe("classifyChatTransportFailure", () => {
  it("names a renamed fetch failure as connectivity", () => {
    expect(classifyChatTransportFailure(new NetworkErrorLike("POST /chat — unreachable"))).toBe(
      "network"
    )
  })

  it("names a raw TypeError as connectivity", () => {
    expect(classifyChatTransportFailure(new TypeError("Failed to fetch"))).toBe("network")
  })

  it.each([502, 503, 504, 500])("carries the status failover threw (%i)", (status) => {
    expect(classifyChatTransportFailure(new Error(`HTTP ${status}`))).toBe(`http_${status}`)
  })

  it("reports a server fault with no status as server_unreachable", () => {
    expect(classifyChatTransportFailure(new Error("failover: all servers unreachable"))).toBe(
      "server_unreachable"
    )
  })

  it("does not read a status out of an unrelated number in the message", () => {
    expect(classifyChatTransportFailure(new Error("timed out after 15000ms"))).toBe(
      "server_unreachable"
    )
  })

  it("falls back to a server fault for a non-Error throw", () => {
    expect(classifyChatTransportFailure("boom")).toBe("server_unreachable")
  })
})

async function drain(request: () => Promise<Response>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const event of streamChat([{ role: "user", content: "hi" }], "en", {
    request,
    getAccessToken: () => Promise.resolve("token"),
  })) {
    events.push(event)
  }
  return events
}

describe("streamChat — every attempt threw", () => {
  it("reports a backend outage as a server failure, not the user's connection", async () => {
    const request = vi.fn(() => Promise.reject(new Error("HTTP 502")))

    const events = await drain(request as unknown as () => Promise<Response>)

    expect(events).toEqual([
      { type: "error", code: "http_502", message: "HTTP 502" },
    ])
    expect(request).toHaveBeenCalledTimes(3)
  })

  it("still reports a genuine connectivity failure as network", async () => {
    const request = vi.fn(() => Promise.reject(new NetworkErrorLike("POST /chat — unreachable")))

    const events = await drain(request as unknown as () => Promise<Response>)

    expect(events[0]).toMatchObject({ type: "error", code: "network" })
  })
})
