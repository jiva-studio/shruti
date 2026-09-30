import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

const ctx = vi.hoisted(() => ({
  resolveLocalUrl: vi.fn<(url: string) => Promise<string | null>>(),
  findAuthor: vi.fn<(id: string) => Promise<unknown>>(),
  reportError: vi.fn(),
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    activeServer: ref({ urlTemplate: "https://cdn.example/{path}" }),
    mediaDownloader: { resolveLocalUrl: ctx.resolveLocalUrl },
    storagePublicUrl: { get: (path: string) => `https://public.example/${path}` },
  }),
}))
vi.mock("@shruti/wiring/catalogUseCases.js", () => ({
  useCatalogUseCases: () => ({ findAuthor: ctx.findAuthor }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError: ctx.reportError }))

import { usePlaylistQueueBuilder } from "../usePlaylistQueueBuilder.js"

const boom = new Error("bridge gone")

function entry(n: number) {
  const track = {
    id: `t-${n}`,
    authorId: "a-1",
    authorRaw: "Raw Author",
    variants: [{ language: "en", title: `Lecture ${n}`, audio: { path: `audio/${n}.mp3` } }],
  } as unknown as Track
  return { item: { id: `i-${n}` as PlaylistItemId }, track }
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx.resolveLocalUrl.mockResolvedValue(null)
  ctx.findAuthor.mockResolvedValue(null)
})

describe("usePlaylistQueueBuilder — lookups that fail", () => {
  it("reports a local file lookup that fails and streams from the public url", async () => {
    ctx.resolveLocalUrl.mockRejectedValueOnce(boom)

    const [first] = await usePlaylistQueueBuilder().buildFrom([entry(1)], "i-1" as PlaylistItemId)

    expect(first?.url).toBe("https://public.example/audio/1.mp3")
    expect(ctx.reportError).toHaveBeenCalledWith("playlist", boom)
  })

  it("reports an author lookup that fails once and names the raw author for the whole queue", async () => {
    ctx.findAuthor.mockRejectedValueOnce(boom)

    const queue = await usePlaylistQueueBuilder().buildFrom(
      [entry(1), entry(2)],
      "i-1" as PlaylistItemId
    )

    expect(queue.map((q) => q.author)).toEqual(["Raw Author", "Raw Author"])
    expect(ctx.findAuthor).toHaveBeenCalledOnce()
    expect(ctx.reportError).toHaveBeenCalledExactlyOnceWith("playlist", boom)
  })
})
