import { describe, expect, it } from "vitest"
import { useHttpShareAudioService } from "../shareAudio/http/useHttpShareAudioService.js"
import { useHttpShareVideoService } from "../shareVideo/http/useHttpShareVideoService.js"
import { useHttpShareTranscriptService } from "../shareTranscript/http/useHttpShareTranscriptService.js"
import { extractShareKey } from "../shareArtifactUrl.js"

/** The active region's storage — not the host the share service answers with. */
const onActiveRegion = (key: string): string => `https://active.example/${key}`

function answering(body: Record<string, unknown>) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
}

describe("extractShareKey", () => {
  it("keeps the object key from its public/ segment on, whatever host or prefix precedes it", () => {
    expect(extractShareKey("https://primary.example/public/shares/audio/n1.mp3")).toBe(
      "public/shares/audio/n1.mp3"
    )
    expect(extractShareKey("https://storage.example/bucket/public/shares/t/t1.pdf")).toBe(
      "public/shares/t/t1.pdf"
    )
  })

  it("has no key for an empty, relative or keyless url", () => {
    expect(extractShareKey("")).toBeNull()
    expect(extractShareKey("/public/shares/audio/n1.mp3")).toBeNull()
    expect(extractShareKey("https://primary.example/elsewhere/n1.mp3")).toBeNull()
    expect(extractShareKey(42)).toBeNull()
  })
})

describe("share adapters build artifact urls from the active region", () => {
  const PRIMARY = "https://primary.example/public/shares/audio/n1.mp3"

  it("share-audio", async () => {
    const svc = useHttpShareAudioService(
      answering({ excerpt_id: "n1", url: PRIMARY, ready: true }),
      onActiveRegion
    )
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
    expect(result.url).toBe("https://active.example/public/shares/audio/n1.mp3")
    expect(result.ready).toBe(true)
  })

  it("share-video", async () => {
    const svc = useHttpShareVideoService(
      answering({
        video_id: "v1",
        url: "https://primary.example/public/shares/video/v1.mp4",
        ready: true,
      }),
      async () => "token",
      onActiveRegion
    )
    const result = await svc.cut({
      sourceKey: "k",
      startMs: 0,
      endMs: 1,
      text: "t",
      lang: "en",
      theme: "plain",
      videoId: "v1",
    })
    expect(result.url).toBe("https://active.example/public/shares/video/v1.mp4")
  })

  it("share-transcript", async () => {
    const svc = useHttpShareTranscriptService(
      answering({ url: "https://primary.example/public/shares/transcripts/t1.pdf", ready: true }),
      onActiveRegion
    )
    const result = await svc.renderPdf({ trackId: "t1", lang: "en", transcriptKey: "k" })
    expect(result.url).toBe("https://active.example/public/shares/transcripts/t1.pdf")
  })

  it("drops a url it cannot key, so the caller polls its own prediction", async () => {
    const svc = useHttpShareAudioService(
      answering({ excerpt_id: "n1", url: "https://primary.example/n1.mp3", ready: true }),
      onActiveRegion
    )
    const result = await svc.cut({ sourceKey: "k", startMs: 0, endMs: 1, excerptId: "n1" })
    expect(result).toEqual({ excerptId: "n1", url: "", ready: false })
  })
})
