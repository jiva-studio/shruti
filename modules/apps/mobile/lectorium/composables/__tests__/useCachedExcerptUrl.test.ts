import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IExcerptCache } from "@ports/app/index.js"

const cached = new Map<string, string>()
const downloads: { url: string; filename: string }[] = []
let downloadFails: Error | null = null

const excerptCache: IExcerptCache = {
  async findLocal(filename) {
    return cached.get(filename) ?? null
  },
  async probeRemote() {
    return false
  },
  async download({ url, filename }) {
    if (downloadFails) throw downloadFails
    downloads.push({ url, filename })
    const uri = `file:///cache/${filename}`
    cached.set(filename, uri)
    return uri
  },
  toLocalUrl(fileUri) {
    return fileUri.replace("file:///cache/", "http://localhost/_capacitor_file_/cache/")
  },
}

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ excerptCache }),
}))

import { useCachedExcerptUrl } from "../useCachedExcerptUrl.js"

const REMOTE = "https://cdn.example/public/tracks/t-1/excerpt/1000-2000.mp3"

describe("useCachedExcerptUrl", () => {
  beforeEach(() => {
    cached.clear()
    downloads.length = 0
    downloadFails = null
  })

  it("downloads on a miss and returns a URL the WebView can load", async () => {
    const url = await useCachedExcerptUrl().resolve(() => REMOTE)

    expect(downloads).toEqual([
      { url: REMOTE, filename: "public_tracks_t-1_excerpt_1000-2000.mp3" },
    ])
    expect(url).toBe(
      "http://localhost/_capacitor_file_/cache/public_tracks_t-1_excerpt_1000-2000.mp3"
    )
  })

  it("replays a cached excerpt without downloading it again", async () => {
    const { resolve } = useCachedExcerptUrl()
    const first = await resolve(() => REMOTE)
    const second = await resolve(() => REMOTE)

    expect(second).toBe(first)
    expect(downloads).toHaveLength(1)
  })

  it("keeps excerpts from different sources apart", async () => {
    const other = "https://cdn.example/public/verses/bg-2-13/recitation.mp3"
    const { resolve } = useCachedExcerptUrl()

    await resolve(() => REMOTE)
    await resolve(() => other)

    expect(downloads.map((d) => d.filename)).toEqual([
      "public_tracks_t-1_excerpt_1000-2000.mp3",
      "public_verses_bg-2-13_recitation.mp3",
    ])
  })

  it("ignores the query string when naming the cached copy", async () => {
    const { resolve } = useCachedExcerptUrl()

    await resolve(() => `${REMOTE}?token=a`)
    await resolve(() => `${REMOTE}?token=b`)

    expect(downloads).toHaveLength(1)
  })

  it("awaits a URL the caller resolves lazily", async () => {
    const url = await useCachedExcerptUrl().resolve(async () => REMOTE)

    expect(downloads).toHaveLength(1)
    expect(url).toContain("1000-2000.mp3")
  })

  it("surfaces a failed download rather than returning a dead URL", async () => {
    downloadFails = new Error("offline")

    await expect(useCachedExcerptUrl().resolve(() => REMOTE)).rejects.toThrow("offline")
    expect(cached.size).toBe(0)
  })

  it("rejects a URL it cannot parse", async () => {
    await expect(useCachedExcerptUrl().resolve(() => "not-a-url")).rejects.toThrow()
    expect(downloads).toEqual([])
  })
})
