import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadWithProgress } from "../streamDownloader.js"

/** 16-byte SQLite magic header (final byte is NUL). */
const SQLITE_HEADER = "SQLite format 3\0"

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A valid-looking SQLite blob body: magic header + some padding pages. */
function validBody(): Uint8Array {
  return bytes(SQLITE_HEADER + "x".repeat(64))
}

/**
 * Build a fake `fetch` Response whose `body.getReader()` emits `chunks` in
 * order. `chunkWithDone` makes the LAST chunk arrive together with `done:true`
 * (legal per the Streams spec) instead of on its own read — the case that used
 * to drop the final chunk.
 */
function mockFetch(opts: {
  chunks: Uint8Array[]
  contentLength?: number | null
  chunkWithDone?: boolean
  ok?: boolean
}): void {
  const { chunks, contentLength, chunkWithDone = false, ok = true } = opts
  let i = 0
  const reader = {
    read: vi.fn(async () => {
      if (i >= chunks.length) return { done: true, value: undefined }
      const value = chunks[i]
      i++
      const isLast = i >= chunks.length
      if (isLast && chunkWithDone) return { done: true, value }
      return { done: false, value }
    }),
  }
  const headers = new Map<string, string>()
  if (contentLength != null) headers.set("content-length", String(contentLength))

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      statusText: ok ? "OK" : "Internal Server Error",
      body: { getReader: () => reader },
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    }))
  )
}

const noop = (): void => undefined

describe("streamDownloader — downloadWithProgress integrity guards", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("resolves a complete download whose length matches content-length", async () => {
    const body = validBody()
    mockFetch({ chunks: [body], contentLength: body.length })

    const blob = await downloadWithProgress("https://cdn/db", noop)
    expect(blob.size).toBe(body.length)
  })

  it("throws when received bytes are fewer than the declared content-length", async () => {
    const body = validBody()
    // Declare more than we deliver — a clean-but-short TCP close.
    mockFetch({ chunks: [body], contentLength: body.length + 100 })

    await expect(downloadWithProgress("https://cdn/db", noop)).rejects.toThrow(/Truncated download/)
  })

  it("does NOT throw on a length check when content-length is missing (total=0)", async () => {
    const body = validBody()
    // No content-length header at all → total resolves to 0, length check skipped.
    mockFetch({ chunks: [body], contentLength: null })

    const blob = await downloadWithProgress("https://cdn/db", noop)
    expect(blob.size).toBe(body.length)
  })

  it("includes a chunk delivered together with done:true", async () => {
    const head = bytes(SQLITE_HEADER)
    const tail = bytes("x".repeat(64))
    // Final chunk (tail) arrives WITH done:true; it must not be dropped.
    mockFetch({
      chunks: [head, tail],
      contentLength: head.length + tail.length,
      chunkWithDone: true,
    })

    const blob = await downloadWithProgress("https://cdn/db", noop)
    expect(blob.size).toBe(head.length + tail.length)
  })

  it("throws when the body is shorter than the 16-byte SQLite header", async () => {
    const tiny = bytes("SQLite")
    mockFetch({ chunks: [tiny], contentLength: tiny.length })

    await expect(downloadWithProgress("https://cdn/db", noop)).rejects.toThrow(/too small/)
  })

  it("throws when the header bytes are not the SQLite magic", async () => {
    const bogus = bytes("NOTASQLITEDB____" + "x".repeat(32))
    mockFetch({ chunks: [bogus], contentLength: bogus.length })

    await expect(downloadWithProgress("https://cdn/db", noop)).rejects.toThrow(/not a valid SQLite/)
  })
})
