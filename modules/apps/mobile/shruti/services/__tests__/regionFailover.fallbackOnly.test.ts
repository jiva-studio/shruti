import { describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import { createRegionFailoverClient } from "../regionFailover.js"
import { NetworkError } from "../http/networkError.js"

const A = { id: "a", chatBaseUrl: "https://api-a.example" } as CdnServer
const B = { id: "b", chatBaseUrl: "https://api-b.example" } as CdnServer
const Z = { id: "z", chatBaseUrl: "https://api-z.example", fallbackOnly: true } as CdnServer

const unavailable = (): Response => new Response("", { status: 503 })
const ok = (): Response => new Response("{}", { status: 200 })

function client(servers: readonly CdnServer[], preferredId: string, fetchImpl: typeof fetch) {
  return createRegionFailoverClient({
    getServers: () => servers,
    getPreferredId: () => preferredId,
    pickBaseUrl: (s) => s.chatBaseUrl,
    fetchImpl,
  })
}

describe("createRegionFailoverClient with fallback-only regions", () => {
  it("never walks onto a fallback-only region", async () => {
    const fetchImpl = vi.fn(async () => unavailable())
    const c = client([A, Z, B], "a", fetchImpl as unknown as typeof fetch)

    await expect(c.request("/title")).rejects.toThrow()

    const urls = fetchImpl.mock.calls.map((call) => String((call as unknown[])[0]))
    expect(urls).toEqual(["https://api-a.example/title", "https://api-b.example/title"])
  })

  it("fails at once with a NetworkError while a fallback-only region is active", async () => {
    const fetchImpl = vi.fn(async () => ok())
    const c = client([A, Z], "z", fetchImpl as unknown as typeof fetch)

    const err = await c.request("/chat", { method: "POST" }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).method).toBe("POST")
    expect((err as NetworkError).path).toBe("/chat")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("resolves no URL while a fallback-only region is active", () => {
    const c = client([A, Z], "z", vi.fn() as unknown as typeof fetch)
    expect(c.resolveUrl("/title")).toBe("")
  })

  it("routes normally once a regular region is active again", async () => {
    const fetchImpl = vi.fn(async () => ok())
    const c = client([A, Z], "a", fetchImpl as unknown as typeof fetch)

    const res = await c.request("/title")

    expect(res.status).toBe(200)
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe("https://api-a.example/title")
  })
})
