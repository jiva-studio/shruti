import { describe, it, expect, vi } from "vitest"
import { createFailoverClient } from "../failover.js"

interface TestServer {
  id: string
  base: string
}

const SERVERS: TestServer[] = [
  { id: "a", base: "https://a.example.com" },
  { id: "b", base: "https://b.example.com" },
]

function res(status: number): Response {
  return new Response(status === 204 ? null : "body", { status })
}

function makeClient(opts: {
  fetchImpl: typeof fetch
  preferred?: string
  now?: () => number
  promoteAfterMs?: number
  onPromote?: (id: string) => void
}) {
  return createFailoverClient<TestServer>({
    getServers: () => SERVERS,
    getPreferredId: () => opts.preferred ?? "a",
    pickBaseUrl: (s) => s.base,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    promoteAfterMs: opts.promoteAfterMs,
    onPromoteFallback: opts.onPromote,
  })
}

describe("createFailoverClient.resolveUrl", () => {
  it("joins the preferred server base with the path", () => {
    const client = makeClient({ fetchImpl: vi.fn() as unknown as typeof fetch, preferred: "b" })
    expect(client.resolveUrl("/x")).toBe("https://b.example.com/x")
  })
})

describe("createFailoverClient.request", () => {
  it("returns the preferred server's response on success", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://a.example.com/cfg")
      return res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    const r = await client.request("/cfg")
    expect(r.status).toBe(200)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("falls through to the fallback on a transient 503", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith("https://a") ? res(503) : res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    const r = await client.request("/cfg")
    expect(r.status).toBe(200)
    expect(calls).toEqual(["https://a.example.com/cfg", "https://b.example.com/cfg"])
  })

  it("does NOT fall through on a non-transient 4xx", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return res(401)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    const r = await client.request("/cfg")
    expect(r.status).toBe(401)
    expect(calls).toEqual(["https://a.example.com/cfg"])
  })

  it("falls through on a thrown network error", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.startsWith("https://a")) throw new Error("ECONNREFUSED")
      return res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    const r = await client.request("/cfg")
    expect(r.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  it("rethrows an AbortError without trying fallbacks", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      const e = new Error("aborted")
      e.name = "AbortError"
      throw e
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    await expect(client.request("/cfg")).rejects.toThrow("aborted")
    expect(calls.length).toBe(1)
  })

  it("throws when every server fails transiently", async () => {
    const fetchImpl = vi.fn(async () => res(503)) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })
    await expect(client.request("/cfg")).rejects.toThrow("HTTP 503")
  })

  it("does NOT promote a fallback before promoteAfterMs elapses", async () => {
    let t = 0
    const now = () => t
    const onPromote = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith("https://a") ? res(503) : res(200)
    ) as unknown as typeof fetch
    const client = makeClient({ fetchImpl, now, promoteAfterMs: 1000, onPromote })

    // First request at t=0: preferred 'a' fails (records outage start), 'b' wins.
    await client.request("/1")
    // Second request at t=500: still within the window — no promotion.
    t = 500
    await client.request("/2")
    expect(onPromote).not.toHaveBeenCalled()
  })

  it("promotes a fallback once the preferred has been down past promoteAfterMs", async () => {
    let t = 0
    const now = () => t
    const onPromote = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith("https://a") ? res(503) : res(200)
    ) as unknown as typeof fetch
    const client = makeClient({ fetchImpl, now, promoteAfterMs: 1000, onPromote })

    await client.request("/1") // t=0, outage starts, 'b' succeeds
    t = 1500 // past the window
    await client.request("/2") // 'a' still down, 'b' succeeds -> promote 'b'
    expect(onPromote).toHaveBeenCalledTimes(1)
    expect(onPromote).toHaveBeenCalledWith("b")
  })

  it("resets the outage clock when the preferred id changes", async () => {
    let t = 0
    const now = () => t
    let preferred = "a"
    const onPromote = vi.fn()
    const fetchImpl = vi.fn(async (url: string) => {
      // 'a' always down, others up.
      return url.startsWith("https://a") ? res(503) : res(200)
    }) as unknown as typeof fetch
    const client = createFailoverClient<TestServer>({
      getServers: () => SERVERS,
      getPreferredId: () => preferred,
      pickBaseUrl: (s) => s.base,
      fetchImpl,
      now,
      promoteAfterMs: 1000,
      onPromoteFallback: onPromote,
    })

    await client.request("/1") // t=0 outage of 'a' starts
    t = 2000
    preferred = "b" // user flipped — 'b' is reachable, no outage
    await client.request("/2")
    expect(onPromote).not.toHaveBeenCalled()
  })
})

describe("createFailoverClient.request cross-server replay gate", () => {
  it("does NOT replay a POST on the other server when the preferred is down", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith("https://a") ? res(503) : res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    await expect(client.request("/profile/sync/pull", { method: "POST" })).rejects.toThrow(
      "HTTP 503"
    )
    expect(calls).toEqual(["https://a.example.com/profile/sync/pull"])
  })

  it.each(["PUT", "PATCH", "DELETE"])("does NOT replay a %s either", async (method) => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return res(503)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    await expect(client.request("/x", { method })).rejects.toThrow("HTTP 503")
    expect(calls.length).toBe(1)
  })

  it("still fails over a GET", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith("https://a") ? res(503) : res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    const r = await client.request("/orchestrator/run/42", { method: "GET" })
    expect(r.status).toBe(200)
    expect(calls).toEqual([
      "https://a.example.com/orchestrator/run/42",
      "https://b.example.com/orchestrator/run/42",
    ])
  })

  it("fails over a POST that opts in with crossServerReplay", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith("https://a") ? res(503) : res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    const r = await client.request("/discovery/search", {
      method: "POST",
      crossServerReplay: true,
    })
    expect(r.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  it("pins a GET to the preferred server when crossServerReplay is false", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return res(503)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    await expect(client.request("/x", { crossServerReplay: false })).rejects.toThrow("HTTP 503")
    expect(calls.length).toBe(1)
  })

  it("does not leak crossServerReplay into the fetch init", async () => {
    let seen: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen = init
      return res(200)
    }) as unknown as typeof fetch
    const client = makeClient({ fetchImpl })

    await client.request("/discovery/search", {
      method: "POST",
      body: "{}",
      crossServerReplay: true,
    })
    expect(seen).toBeDefined()
    expect("crossServerReplay" in seen!).toBe(false)
    expect(seen!.body).toBe("{}")
  })

  it("records the preferred outage on a blocked POST so a later GET can promote", async () => {
    let t = 0
    const onPromote = vi.fn()
    const fetchImpl = vi.fn(async (url: string) =>
      url.startsWith("https://a") ? res(503) : res(200)
    ) as unknown as typeof fetch
    const client = makeClient({ fetchImpl, now: () => t, promoteAfterMs: 1000, onPromote })

    await expect(client.request("/push", { method: "POST" })).rejects.toThrow("HTTP 503")
    t = 1500
    await client.request("/read")
    expect(onPromote).toHaveBeenCalledWith("b")
  })
})
