import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeScheduledRevoke } from "../scheduledRevoke.js"

// In-memory IPreferences stub. Backs the queue store so each test
// starts with an empty store and we can assert read state directly.
function makeMemoryPrefs() {
  const store = new Map<string, string>()
  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async remove(key: string): Promise<void> {
      store.delete(key)
    },
    _store: store,
  }
}

const KEY = "auth.pendingRevoke"
const resolveAuthBaseUrl = (regionId: string): string => {
  if (regionId === "global") return "https://global.example/auth"
  if (regionId === "russia") return "https://russia.example/auth"
  throw new Error(`unknown region: ${regionId}`)
}

describe("makeScheduledRevoke", () => {
  let prefs: ReturnType<typeof makeMemoryPrefs>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    prefs = makeMemoryPrefs()
    fetchMock = vi.fn()
  })

  it("enqueue writes one entry; drain on 204 clears it", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.enqueue("global", "bearer-1")
    expect(prefs._store.has(KEY)).toBe(true)
    await svc.drain()
    expect(prefs._store.has(KEY)).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]!
    expect(call[0]).toBe("https://global.example/auth/migrate-revoke")
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer bearer-1",
    })
  })

  it("treats 410 (already gone) as terminal success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 410 }))
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.enqueue("russia", "bearer-2")
    await svc.drain()
    expect(prefs._store.has(KEY)).toBe(false)
  })

  it("re-enqueues with bumped attempts on 5xx and on network error", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("connection refused"))
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.enqueue("global", "bearer-3")
    await svc.drain()
    let raw = prefs._store.get(KEY)
    expect(raw).toBeTruthy()
    let parsed = JSON.parse(raw!) as { attempts: number }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.attempts).toBe(1)
    // Second drain hits a network error path.
    await svc.drain()
    raw = prefs._store.get(KEY)
    parsed = JSON.parse(raw!) as { attempts: number }[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.attempts).toBe(2)
  })

  it("drops entry after MAX_ATTEMPTS without firing fetch", async () => {
    // Pre-load a 30-attempt entry — at the cap, drain must drop and
    // never re-issue the request.
    await prefs.set(
      KEY,
      JSON.stringify([{ regionId: "global", bearer: "exhausted", attempts: 30, createdAt: 0 }])
    )
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.drain()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(prefs._store.has(KEY)).toBe(false)
  })

  it("drops entry whose region id is no longer in the registry", async () => {
    await prefs.set(
      KEY,
      JSON.stringify([{ regionId: "atlantis", bearer: "drift", attempts: 0, createdAt: 0 }])
    )
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.drain()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(prefs._store.has(KEY)).toBe(false)
  })

  it("drain on empty queue is a no-op", async () => {
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.drain()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("handles malformed stored JSON as empty queue", async () => {
    await prefs.set(KEY, "{not json[")
    const svc = makeScheduledRevoke({
      prefs,
      resolveAuthBaseUrl,
      fetch: fetchMock as unknown as typeof fetch,
    })
    await svc.drain()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
