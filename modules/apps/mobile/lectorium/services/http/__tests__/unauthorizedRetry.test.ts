import { describe, expect, it, vi } from "vitest"
import { createUnauthorizedRetry, isReplayableBody } from "../unauthorizedRetry.js"

const authed = (token: string): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ hello: "world" }),
})

function bearerOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("Authorization")
}

describe("createUnauthorizedRetry", () => {
  it("passes a successful response through untouched", async () => {
    const ok = new Response(null, { status: 200 })
    const inner = vi.fn().mockResolvedValue(ok)
    const refreshAccessToken = vi.fn()
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    expect(await wrapped("/x", authed("stale"))).toBe(ok)
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalledOnce()
  })

  it("does not refresh on a non-401 error status", async () => {
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    const refreshAccessToken = vi.fn()
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    expect((await wrapped("/x", authed("stale"))).status).toBe(403)
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it("forces one refresh on a 401 and replays with the new bearer", async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    const res = await wrapped("/profile/sync/pull", authed("stale"))

    expect(res.status).toBe(200)
    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(inner).toHaveBeenCalledTimes(2)
    expect(bearerOf(inner.mock.calls[0]![1])).toBe("Bearer stale")
    expect(bearerOf(inner.mock.calls[1]![1])).toBe("Bearer fresh")
  })

  it("preserves method, body and extra init fields on the replay", async () => {
    const inner = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const wrapped = createUnauthorizedRetry({
      refreshAccessToken: vi.fn().mockResolvedValue("fresh"),
    })(inner)
    const signal = AbortSignal.timeout(10_000)

    await wrapped("/discovery/search", { ...authed("stale"), signal })

    const replay = inner.mock.calls[1]![1] as RequestInit
    expect(replay.method).toBe("POST")
    expect(replay.body).toBe(JSON.stringify({ hello: "world" }))
    expect(replay.signal).toBe(signal)
    expect(new Headers(replay.headers).get("Content-Type")).toBe("application/json")
  })

  it("collapses N concurrent 401s into ONE refresh and replays every one", async () => {
    const N = 8
    let releaseRefresh!: (token: string) => void
    const refreshAccessToken = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          releaseRefresh = resolve
        })
    )
    const seen: string[] = []
    const inner = vi.fn(async (_path: string, init?: RequestInit) => {
      const bearer = bearerOf(init)!
      seen.push(bearer)
      return new Response(null, { status: bearer === "Bearer stale" ? 401 : 200 })
    })
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    const inFlight = Array.from({ length: N }, (_, i) => wrapped(`/x/${i}`, authed("stale")))
    // Let all N first attempts land on the 401 before the refresh resolves.
    await vi.waitFor(() => expect(seen.length).toBe(N))
    releaseRefresh("fresh")
    const results = await Promise.all(inFlight)

    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(200))
    expect(seen.filter((b) => b === "Bearer fresh")).toHaveLength(N)
  })

  it("replays a late 401 with the already-refreshed token, without refreshing again", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    let releaseSecond!: () => void
    const secondLanded = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const inner = vi.fn(async (path: string, init?: RequestInit) => {
      const bearer = bearerOf(init)
      // The second request left with the stale bearer at the same time as the
      // first, but its 401 only comes back after the refresh already landed.
      if (path === "/second" && bearer === "Bearer stale") await secondLanded
      return new Response(null, { status: bearer === "Bearer fresh" ? 200 : 401 })
    })
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    const first = wrapped("/first", authed("stale"))
    const second = wrapped("/second", authed("stale"))
    await first
    releaseSecond()

    expect((await second).status).toBe(200)
    expect(refreshAccessToken).toHaveBeenCalledOnce()
  })

  it("stops instead of looping when the token is permanently invalid", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh-but-still-rejected")
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken, now: () => 0 })(inner)

    // Attempt + one replay, then the cooldown blocks any further refresh.
    expect((await wrapped("/a", authed("stale"))).status).toBe(401)
    expect((await wrapped("/b", authed("stale"))).status).toBe(401)
    expect((await wrapped("/c", authed("stale"))).status).toBe(401)

    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(inner).toHaveBeenCalledTimes(4) // 3 attempts + 1 replay
  })

  it("retries again once the cooldown has elapsed", async () => {
    let t = 0
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken, now: () => t })(inner)

    await wrapped("/a", authed("stale"))
    t = 60_001
    await wrapped("/b", authed("stale"))

    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it("clears the cooldown when a new session arrives", async () => {
    let t = 0
    // Default no-op so the UNFIXED factory (which never subscribes) fails on
    // the assertion below rather than on a missing callback.
    let announceSession = (): void => {}
    const refreshAccessToken = vi
      .fn()
      // The first refresh hands back a token the server still rejects — that
      // is what opens the 60s cooldown.
      .mockResolvedValueOnce("still-rejected")
      .mockResolvedValue("signed-in")
    const inner = vi.fn(
      async (_path: string, init?: RequestInit) =>
        new Response(null, { status: bearerOf(init) === "Bearer signed-in" ? 200 : 401 })
    )
    const wrapped = createUnauthorizedRetry({
      refreshAccessToken,
      now: () => t,
      onSessionChange: (listener) => {
        announceSession = listener
        return () => {}
      },
    })(inner)

    expect((await wrapped("/a", authed("stale"))).status).toBe(401)
    expect(refreshAccessToken).toHaveBeenCalledOnce()

    // Well inside the cooldown, the user signs in with Google: a brand-new
    // session and a brand-new token. The previous session's verdict says
    // nothing about it, so the next 401 must still be recoverable.
    t = 5_000
    announceSession()

    expect((await wrapped("/b", authed("stale"))).status).toBe(200)
    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it("replays a late 401 with the token in hand even while the cooldown is open", async () => {
    let releaseB!: () => void
    const bLanded = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    const inner = vi.fn(async (path: string, init?: RequestInit) => {
      const bearer = bearerOf(init)
      // `/b` left with the stale bearer alongside `/a`, but its 401 only comes
      // back after `/a` has already opened the cooldown.
      if (path === "/b" && bearer === "Bearer stale") await bLanded
      // `/a` is forbidden for this user whatever the token — a route verdict,
      // not a stale token. `/b` is fine once the bearer is fresh.
      if (path === "/a") return new Response(null, { status: 401 })
      return new Response(null, { status: bearer === "Bearer fresh" ? 200 : 401 })
    })
    const wrapped = createUnauthorizedRetry({ refreshAccessToken, now: () => 0 })(inner)

    const a = wrapped("/a", authed("stale"))
    const b = wrapped("/b", authed("stale"))
    expect((await a).status).toBe(401)
    releaseB()

    // The cooldown exists to stop a refresh per request. `/b` needs no
    // refresh — the token is already in hand — so it must not be blocked.
    expect((await b).status).toBe(200)
    expect(refreshAccessToken).toHaveBeenCalledOnce()
  })

  it("surfaces the 401 without replaying when the session is unrecoverable", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue(null)
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    expect((await wrapped("/x", authed("stale"))).status).toBe(401)
    expect(inner).toHaveBeenCalledOnce()
  })

  it("surfaces the 401 when the refresh itself throws", async () => {
    const refreshAccessToken = vi.fn().mockRejectedValue(new Error("offline"))
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    expect((await wrapped("/x", authed("stale"))).status).toBe(401)
    expect(inner).toHaveBeenCalledOnce()
  })

  it("ignores a 401 on a request that carries no bearer", async () => {
    const refreshAccessToken = vi.fn()
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)

    await wrapped("/x", { method: "POST", body: "{}" })

    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalledOnce()
  })

  it("does not replay a one-shot stream body", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    const inner = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    const wrapped = createUnauthorizedRetry({ refreshAccessToken })(inner)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    })

    await wrapped("/x", { ...authed("stale"), body })

    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalledOnce()
  })

  it("shares one refresh across clients built from the same factory", async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue("fresh")
    const decorate = createUnauthorizedRetry({ refreshAccessToken })
    const respond = () =>
      vi.fn(async (_p: string, init?: RequestInit) =>
        bearerOf(init) === "Bearer fresh"
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 401 })
      )
    const sync = decorate(respond())
    const ingest = decorate(respond())

    const [a, b] = await Promise.all([
      sync("/profile/sync/push", authed("stale")),
      ingest("/orchestrator/run", authed("stale")),
    ])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(refreshAccessToken).toHaveBeenCalledOnce()
  })
})

describe("isReplayableBody", () => {
  it("accepts an absent body and a JSON string", () => {
    expect(isReplayableBody(undefined)).toBe(true)
    expect(isReplayableBody(null)).toBe(true)
    expect(isReplayableBody('{"a":1}')).toBe(true)
  })

  it("accepts the re-sendable platform bodies", () => {
    expect(isReplayableBody(new URLSearchParams({ a: "1" }))).toBe(true)
    expect(isReplayableBody(new FormData())).toBe(true)
    expect(isReplayableBody(new Blob(["x"]))).toBe(true)
    expect(isReplayableBody(new ArrayBuffer(4))).toBe(true)
    expect(isReplayableBody(new Uint8Array([1, 2]))).toBe(true)
  })

  it("rejects a one-shot stream", () => {
    const stream = new ReadableStream()
    expect(isReplayableBody(stream as unknown as BodyInit)).toBe(false)
  })
})
