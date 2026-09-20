import { describe, it, expect, vi } from "vitest"
import { probeServers } from "../prober.js"

interface TestServer {
  id: string
  urlTemplate: string
}

const SERVERS: TestServer[] = [
  { id: "a", urlTemplate: "https://a.example.com/{path}" },
  { id: "b", urlTemplate: "https://b.example.com/{path}" },
]

const THREE_SERVERS: TestServer[] = [
  ...SERVERS,
  { id: "c", urlTemplate: "https://c.example.com/{path}" },
]

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("probeServers", () => {
  it("returns the first responder with its parsed config", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://a.example.com/config.json")
      return jsonRes({ hello: "world" })
    }) as unknown as typeof fetch
    const result = await probeServers<TestServer, { hello: string }>(SERVERS, {
      configPath: "config.json",
      fetchImpl,
    })
    expect(result).toEqual({ serverId: "a", config: { hello: "world" } })
  })

  it("skips a non-OK server and uses the next", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return url.startsWith("https://a") ? jsonRes({}, 500) : jsonRes({ ok: true })
    }) as unknown as typeof fetch
    const result = await probeServers(SERVERS, { configPath: "config.json", fetchImpl })
    expect(result.serverId).toBe("b")
    expect(calls.length).toBe(2)
  })

  it("skips a server that throws and uses the next", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://a")) throw new Error("boom")
      return jsonRes({ ok: true })
    }) as unknown as typeof fetch
    const result = await probeServers(SERVERS, { configPath: "config.json", fetchImpl })
    expect(result.serverId).toBe("b")
  })

  it("tries the preferred server first", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return jsonRes({ from: url })
    }) as unknown as typeof fetch
    const result = await probeServers(SERVERS, {
      configPath: "config.json",
      preferredServerId: "b",
      fetchImpl,
    })
    expect(result.serverId).toBe("b")
    expect(calls[0]).toBe("https://b.example.com/config.json")
  })

  it("ignores an unknown preferred id and keeps declared order", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return jsonRes({})
    }) as unknown as typeof fetch
    const result = await probeServers(SERVERS, {
      configPath: "config.json",
      preferredServerId: "zzz",
      fetchImpl,
    })
    expect(result.serverId).toBe("a")
  })

  it("throws when all servers are unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    await expect(probeServers(SERVERS, { configPath: "config.json", fetchImpl })).rejects.toThrow(
      "All servers are unreachable"
    )
  })

  it("does not hedge while the head candidate is answering", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return jsonRes({ ok: true })
    }) as unknown as typeof fetch
    const result = await probeServers(THREE_SERVERS, {
      configPath: "config.json",
      hedgeDelayMs: 50,
      fetchImpl,
    })
    expect(result.serverId).toBe("a")
    expect(calls).toEqual(["https://a.example.com/config.json"])
  })

  it("hedges to the next candidate when the head one is slow, and it wins", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.startsWith("https://a")) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return jsonRes({ from: "a" })
      }
      return jsonRes({ from: "b" })
    }) as unknown as typeof fetch
    const result = await probeServers<TestServer, { from: string }>(SERVERS, {
      configPath: "config.json",
      hedgeDelayMs: 5,
      fetchImpl,
    })
    expect(result).toEqual({ serverId: "b", config: { from: "b" } })
    expect(calls).toEqual([
      "https://a.example.com/config.json",
      "https://b.example.com/config.json",
    ])
  })

  it("starts the next candidate immediately when the head one fails fast", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://a")) throw new Error("ECONNREFUSED")
      return jsonRes({ ok: true })
    }) as unknown as typeof fetch
    const startedAt = Date.now()
    const result = await probeServers(SERVERS, {
      configPath: "config.json",
      hedgeDelayMs: 10_000,
      timeoutMs: 10_000,
      fetchImpl,
    })
    expect(result.serverId).toBe("b")
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it("aborts the losing candidates once a winner responds", async () => {
    const signals = new Map<string, AbortSignal>()
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      signals.set(url, init.signal as AbortSignal)
      if (url.startsWith("https://a")) return new Promise<Response>(() => {})
      return Promise.resolve(jsonRes({ ok: true }))
    }) as unknown as typeof fetch
    const result = await probeServers(SERVERS, {
      configPath: "config.json",
      hedgeDelayMs: 5,
      fetchImpl,
    })
    expect(result.serverId).toBe("b")
    expect(signals.get("https://a.example.com/config.json")?.aborted).toBe(true)
  })

  it("aborts a response whose body never arrives", async () => {
    const fetchImpl = vi.fn(async () => {
      return { ok: true, json: () => new Promise<unknown>(() => {}) } as unknown as Response
    }) as unknown as typeof fetch
    await expect(
      probeServers([SERVERS[0]], { configPath: "config.json", timeoutMs: 20, fetchImpl })
    ).rejects.toThrow(new Error("All servers are unreachable"))
  })

  it("throws the exact message when every candidate fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith("https://a")) throw new Error("down")
      return jsonRes({}, 503)
    }) as unknown as typeof fetch
    await expect(
      probeServers(SERVERS, { configPath: "config.json", hedgeDelayMs: 5, fetchImpl })
    ).rejects.toThrow(new Error("All servers are unreachable"))
  })
})
