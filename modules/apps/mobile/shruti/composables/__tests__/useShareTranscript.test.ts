import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RenderTranscriptRequest } from "@ports/app/index.js"

/**
 * #1588: the PDF used to be cached under the lecture's display title, and
 * `resolveShareArtifact` answers from the local cache before it probes the
 * correctly-keyed public URL. Two languages of one lecture render the same
 * title (a single variant makes the fallback identical), so the second
 * share returned the first language's file. The cache key must follow the
 * public key — track and language.
 */
const ctx = vi.hoisted(() => ({
  findLocal: null as unknown as ReturnType<typeof vi.fn>,
  download: null as unknown as ReturnType<typeof vi.fn>,
  renderPdf: null as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    storagePublicUrl: { get: (key: string) => `https://cdn.test/${key}` },
    excerptCache: {
      findLocal: ctx.findLocal,
      probeRemote: vi.fn(async () => true),
      download: ctx.download,
    },
    shareTranscriptService: { renderPdf: ctx.renderPdf },
  }),
}))

const { useShareTranscript } = await import("../useShareTranscript.js")

// Same lecture, same (fallback) title, two transcript languages.
function request(lang: string): RenderTranscriptRequest {
  return {
    trackId: "track_abc",
    lang,
    transcriptKey: `public/tracks/track_abc/transcript.${lang}.json`,
    title: "Шримад-Бхагаватам 1.2.6",
    date: null,
  }
}

describe("useShareTranscript", () => {
  beforeEach(() => {
    ctx.findLocal = vi.fn(async () => null)
    ctx.download = vi.fn(
      async ({ filename }: { url: string; filename: string }) => `file://${filename}`
    )
    ctx.renderPdf = vi.fn(async () => ({ url: "", ready: true }))
  })

  it("keys the cache by track and language, not by the display title", async () => {
    const { prepareLocalPdf } = useShareTranscript()

    await prepareLocalPdf(request("ru"))
    await prepareLocalPdf(request("en"))

    const keys = ctx.findLocal.mock.calls.map((call: unknown[]) => call[0] as string)
    expect(keys).toEqual(["transcript-track_abc-ru.pdf", "transcript-track_abc-en.pdf"])
    for (const key of keys) expect(key).not.toContain("Бхагаватам")
  })

  it("downloads each language under its own cache key", async () => {
    const { prepareLocalPdf } = useShareTranscript()

    await prepareLocalPdf(request("ru"))
    await prepareLocalPdf(request("en"))

    expect(ctx.download).toHaveBeenNthCalledWith(1, {
      url: "https://cdn.test/public/tracks/track_abc/exports/ru.pdf",
      filename: "transcript-track_abc-ru.pdf",
    })
    expect(ctx.download).toHaveBeenNthCalledWith(2, {
      url: "https://cdn.test/public/tracks/track_abc/exports/en.pdf",
      filename: "transcript-track_abc-en.pdf",
    })
  })

  it("separates two undated lectures that share a title", async () => {
    const { prepareLocalPdf } = useShareTranscript()

    await prepareLocalPdf(request("ru"))
    await prepareLocalPdf({ ...request("ru"), trackId: "track_xyz" })

    const keys = ctx.findLocal.mock.calls.map((call: unknown[]) => call[0] as string)
    expect(new Set(keys).size).toBe(2)
  })

  it("reuses the same key for a re-tap, so the cache hit is instant", async () => {
    ctx.findLocal = vi.fn(async () => "file:///cache/transcript-track_abc-ru.pdf")
    const { prepareLocalPdf } = useShareTranscript()

    const uri = await prepareLocalPdf(request("ru"))

    expect(uri).toBe("file:///cache/transcript-track_abc-ru.pdf")
    expect(ctx.renderPdf).not.toHaveBeenCalled()
    expect(ctx.download).not.toHaveBeenCalled()
  })
})
