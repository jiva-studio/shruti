import { describe, expect, it, vi } from "vitest"
import { createHttpDiscoveryClient, DiscoveryGatewayError } from "../discoveryClient.js"

function client(request: ReturnType<typeof vi.fn>, token: string | null = "tok") {
  return createHttpDiscoveryClient({
    getAccessToken: async () => token,
    request: request as unknown as (path: string, init?: RequestInit) => Promise<Response>,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("createHttpDiscoveryClient", () => {
  it("posts the query and returns the hits", async () => {
    const request = vi.fn().mockResolvedValue(json({ items: [{ url: "https://x/1" }] }))

    const result = await client(request).search({ query: "karma" })

    expect(result).toEqual({ items: [{ url: "https://x/1" }] })
    const [path, init] = request.mock.calls[0] as [string, RequestInit]
    expect(path).toBe("/discovery/search")
    expect(JSON.parse(init.body as string)).toEqual({ query: "karma" })
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("passes the caller's abort signal through, so a keystroke can cancel it", async () => {
    const request = vi.fn().mockResolvedValue(json({ items: [] }))
    const controller = new AbortController()

    await client(request).search({ query: "a" }, { signal: controller.signal })

    expect((request.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal)
  })

  it("refuses to call without a session", async () => {
    const request = vi.fn()

    await expect(client(request, null).search({ query: "a" })).rejects.toBeInstanceOf(
      DiscoveryGatewayError
    )
    expect(request).not.toHaveBeenCalled()
  })

  it("surfaces the server's error code so a caller can tell a misconfigured deployment from a retryable failure", async () => {
    const request = vi.fn().mockResolvedValue(json({ error: { code: "not_configured" } }, 503))

    const error = await client(request)
      .search({ query: "a" })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 503, code: "not_configured" })
  })

  it("still reports the status when the error body is not JSON", async () => {
    const request = vi.fn().mockResolvedValue(new Response("<html>401</html>", { status: 401 }))

    const error = await client(request)
      .search({ query: "a" })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 401, code: undefined })
    expect((error as Error).message).toContain("401")
  })
})
