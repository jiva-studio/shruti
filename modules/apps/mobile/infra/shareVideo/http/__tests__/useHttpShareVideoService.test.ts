import { describe, expect, it, vi, afterEach } from "vitest"
import { ShareVideoRateLimitError } from "@ports/app/index.js"
import { useHttpShareVideoService } from "../useHttpShareVideoService.js"

/**
 * Issue #1847: past the per-user daily cap the adapter threw a bare
 * `Error("share-video renderer returned 429 Too Many Requests")` and dropped
 * the server's structured body, so Studio and the Notes share path both said
 * "Couldn't prepare video. Try again." — advice that cannot succeed before
 * midnight UTC, since the bucket is a UTC day.
 */

const REQ = {
  sourceKey: "public/tracks/t/audio/original.mp3",
  startMs: 0,
  endMs: 5_000,
  text: "hare krishna",
  lang: "en",
  theme: "prabhupada",
}

function service() {
  return useHttpShareVideoService(
    () => "https://render.example/reels",
    () => Promise.resolve("token")
  )
}

function respond(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useHttpShareVideoService.cut — daily quota", () => {
  it("turns the 429 body into a typed error carrying the counters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          respond(429, { code: "rate_limited", limit: 5, current: 5, key_type: "user" })
        )
      )
    )

    await expect(service().cut(REQ)).rejects.toMatchObject({
      name: "ShareVideoRateLimitError",
      current: 5,
      limit: 5,
    })
  })

  it("is recognisable by both share paths through instanceof", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(429, { code: "rate_limited", limit: 3, current: 3 })))
    )

    const err = await service()
      .cut(REQ)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ShareVideoRateLimitError)
  })

  it("keeps the generic error for a 429 that is not the quota shape", async () => {
    // A proxy's own 429, or an older service. Nothing to say about a limit we
    // cannot see, so we do not invent one.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(429, { detail: "slow down" }, "Too Many Requests")))
    )

    const err = await service()
      .cut(REQ)
      .catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(ShareVideoRateLimitError)
    expect((err as Error).message).toContain("429")
  })

  it("leaves other failures alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(500, { error: "boom" }, "Internal Server Error")))
    )

    const err = await service()
      .cut(REQ)
      .catch((e: unknown) => e)

    expect(err).not.toBeInstanceOf(ShareVideoRateLimitError)
  })
})
