import { describe, it, expect, vi } from "vitest"
import { createConfigLoader } from "../loader.js"

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createConfigLoader", () => {
  it("fetches and parses the config", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://x/config.json")
      return jsonRes({ a: 1 })
    }) as unknown as typeof fetch
    const loader = createConfigLoader<{ a: number }>({ url: "https://x/config.json", fetchImpl })
    expect(await loader.load()).toEqual({ a: 1 })
  })

  it("resolves a lazy url getter at fetch time", async () => {
    let target = "https://one/c.json"
    const fetchImpl = vi.fn(async (url: string) => jsonRes({ url })) as unknown as typeof fetch
    const loader = createConfigLoader<{ url: string }>({ url: () => target, fetchImpl })
    await loader.load()
    target = "https://two/c.json"
    const r = await loader.refresh()
    expect(r.url).toBe("https://two/c.json")
  })

  it("applies the parse/validate step and rejects bad payloads", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ n: "nope" })) as unknown as typeof fetch
    const loader = createConfigLoader<{ n: number }>({
      url: "https://x",
      fetchImpl,
      parse: (raw) => {
        const o = raw as { n: unknown }
        if (typeof o.n !== "number") throw new Error("invalid config")
        return { n: o.n }
      },
    })
    await expect(loader.load()).rejects.toThrow("invalid config")
  })

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({}, 404)) as unknown as typeof fetch
    const loader = createConfigLoader({ url: "https://x", fetchImpl })
    await expect(loader.load()).rejects.toThrow("HTTP 404")
  })

  it("serves the cached value within the staleness window", async () => {
    let t = 0
    const fetchImpl = vi.fn(async () => jsonRes({ v: 1 })) as unknown as typeof fetch
    const loader = createConfigLoader<{ v: number }>({
      url: "https://x",
      fetchImpl,
      staleAfterMs: 1000,
      now: () => t,
    })
    await loader.load()
    t = 500
    await loader.load()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("re-fetches once the staleness window has passed", async () => {
    let t = 0
    const fetchImpl = vi.fn(async () => jsonRes({ v: 1 })) as unknown as typeof fetch
    const loader = createConfigLoader<{ v: number }>({
      url: "https://x",
      fetchImpl,
      staleAfterMs: 1000,
      now: () => t,
    })
    await loader.load()
    t = 1500
    await loader.load()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("always fetches when caching is disabled (default)", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ v: 1 })) as unknown as typeof fetch
    const loader = createConfigLoader({ url: "https://x", fetchImpl })
    await loader.load()
    await loader.load()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it("coalesces concurrent loads into one fetch", async () => {
    const t = 0
    let resolve!: (r: Response) => void
    const fetchImpl = vi.fn(
      () => new Promise<Response>((res) => (resolve = res))
    ) as unknown as typeof fetch
    const loader = createConfigLoader<{ v: number }>({
      url: "https://x",
      fetchImpl,
      staleAfterMs: 1000,
      now: () => t,
    })
    const p1 = loader.load()
    const p2 = loader.load()
    resolve(jsonRes({ v: 7 }))
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual({ v: 7 })
    expect(b).toEqual({ v: 7 })
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("peek returns the cache and invalidate clears it", async () => {
    const t = 0
    const fetchImpl = vi.fn(async () => jsonRes({ v: 1 })) as unknown as typeof fetch
    const loader = createConfigLoader<{ v: number }>({
      url: "https://x",
      fetchImpl,
      staleAfterMs: 1000,
      now: () => t,
    })
    expect(loader.peek()).toBeUndefined()
    await loader.load()
    expect(loader.peek()).toEqual({ v: 1 })
    loader.invalidate()
    expect(loader.peek()).toBeUndefined()
    await loader.load()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })
})
