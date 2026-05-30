import { describe, expect, it, vi } from "vitest"
import { createFailoverClient } from "../createFailoverClient.js"
import type { CdnServer } from "@lib/domain/servers.js"

const SERVERS: readonly CdnServer[] = [
  {
    id: "global",
    name: "Global",
    urlTemplate: "https://global.example/{path}",
    shareAudioUrl: "https://global.example/share/audio",
    shareVideoUrl: "https://global.example/share/video",
    authBaseUrl: "https://global.example/auth",
    chatBaseUrl: "https://global.example",
  },
  {
    id: "russia",
    name: "Russia",
    urlTemplate: "https://ru.example/{path}",
    shareAudioUrl: "https://ru.example/share/audio",
    shareVideoUrl: "https://ru.example/share/video",
    authBaseUrl: "https://ru.example/auth",
    chatBaseUrl: "https://ru.example",
  },
]

function makeClient(
  opts: Partial<Parameters<typeof createFailoverClient>[0]> & {
    fetchImpl: ReturnType<typeof vi.fn>
    preferredId?: string
  }
) {
  return createFailoverClient({
    getServers: () => SERVERS,
    getPreferredId: () => opts.preferredId ?? "global",
    pickBaseUrl: (s) => s.authBaseUrl,
    ...opts,
  })
}

describe("createFailoverClient", () => {
  it("preferred succeeds → fallback never called", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }))
    const client = makeClient({ fetchImpl })
    const res = await client.request("/me")
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://global.example/auth/me", undefined)
  })

  it("preferred 503 → falls through to next server, returns its response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    const onPromoteFallback = vi.fn()
    const client = makeClient({ fetchImpl, onPromoteFallback })
    const res = await client.request("/me")
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://global.example/auth/me", undefined)
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://ru.example/auth/me", undefined)
    // First 5xx does NOT promote (well under the 5 min threshold).
    expect(onPromoteFallback).not.toHaveBeenCalled()
  })

  it("preferred network error → falls through; non-AbortError doesn't short-circuit", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    const client = makeClient({ fetchImpl })
    const res = await client.request("/me")
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("AbortError on preferred → re-thrown without trying fallbacks", async () => {
    const aborted = new Error("aborted")
    aborted.name = "AbortError"
    const fetchImpl = vi.fn().mockRejectedValueOnce(aborted)
    const client = makeClient({ fetchImpl })
    await expect(client.request("/me")).rejects.toBe(aborted)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("4xx on preferred → returns as-is, does NOT try fallback", async () => {
    // 401 is "the server spoke" — the fallback would just 401 too (same
    // user, same JWT). Failover is only for connectivity, not for auth.
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 401 }))
    const client = makeClient({ fetchImpl })
    const res = await client.request("/me")
    expect(res.status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("all candidates 5xx → throws last error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    const client = makeClient({ fetchImpl })
    await expect(client.request("/me")).rejects.toThrow(/HTTP 503/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("preferred down >5 min, fallback succeeds → promotes fallback", async () => {
    let nowMs = 0
    const fetchImpl = vi.fn()
    const onPromoteFallback = vi.fn()
    const client = makeClient({
      fetchImpl,
      onPromoteFallback,
      now: () => nowMs,
    })

    // First request: preferred fails (records timestamp), fallback wins
    nowMs = 1000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r1")
    expect(onPromoteFallback).not.toHaveBeenCalled()

    // 1 minute later — still under threshold, no promote
    nowMs = 1000 + 60_000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r2")
    expect(onPromoteFallback).not.toHaveBeenCalled()

    // 6 minutes after the first failure → over threshold, promotes
    nowMs = 1000 + 6 * 60_000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r3")
    expect(onPromoteFallback).toHaveBeenCalledExactlyOnceWith("russia")
  })

  it("preferred recovers before threshold → unreachable timer resets, no promote", async () => {
    let nowMs = 0
    const fetchImpl = vi.fn()
    const onPromoteFallback = vi.fn()
    const client = makeClient({
      fetchImpl,
      onPromoteFallback,
      now: () => nowMs,
    })

    nowMs = 1000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r1")

    // 2 minutes later preferred recovers
    nowMs = 1000 + 2 * 60_000
    fetchImpl.mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r2")

    // 10 minutes later preferred goes down again but the gap reset the
    // unreachable timer, so no promote on the new fallback.
    nowMs = 1000 + 12 * 60_000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r3")
    expect(onPromoteFallback).not.toHaveBeenCalled()
  })

  it("user manually switches preferred → unreachable counter is reset", async () => {
    let nowMs = 0
    let preferred = "global"
    const fetchImpl = vi.fn()
    const onPromoteFallback = vi.fn()
    const client = createFailoverClient({
      getServers: () => SERVERS,
      getPreferredId: () => preferred,
      pickBaseUrl: (s) => s.authBaseUrl,
      onPromoteFallback,
      fetchImpl,
      now: () => nowMs,
    })

    nowMs = 1000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r1")

    // User flips preferred to russia via Settings — new id, fresh
    // counter; subsequent 5xx on the new preferred starts from 0.
    preferred = "russia"
    nowMs = 1000 + 10 * 60_000
    fetchImpl.mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r2")
    expect(onPromoteFallback).not.toHaveBeenCalled()
  })

  it("custom promoteAfterMs is honored", async () => {
    let nowMs = 0
    const fetchImpl = vi.fn()
    const onPromoteFallback = vi.fn()
    const client = makeClient({
      fetchImpl,
      onPromoteFallback,
      now: () => nowMs,
      promoteAfterMs: 30_000,
    })

    nowMs = 0
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r1")

    // 40 s later — over the custom 30s threshold.
    nowMs = 40_000
    fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
    await client.request("/r2")
    expect(onPromoteFallback).toHaveBeenCalledExactlyOnceWith("russia")
  })

  it("resolveUrl uses the current preferred server", async () => {
    let preferred = "global"
    const client = createFailoverClient({
      getServers: () => SERVERS,
      getPreferredId: () => preferred,
      pickBaseUrl: (s) => s.chatBaseUrl,
      fetchImpl: vi.fn(),
    })
    expect(client.resolveUrl("/chat")).toBe("https://global.example/chat")
    preferred = "russia"
    expect(client.resolveUrl("/chat")).toBe("https://ru.example/chat")
  })
})
