import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IExcerptCache } from "@ports/app/index.js"
import { resolveShareArtifact } from "../resolveShareArtifact.js"
import * as pollModule from "../pollUntilReady.js"

function makeCache(overrides: Partial<IExcerptCache> = {}): IExcerptCache {
  return {
    findLocal: vi.fn(async () => null),
    probeRemote: vi.fn(async () => false),
    download: vi.fn(async ({ url }: { url: string; filename: string }) => `file:///cache/${url}`),
    ...overrides,
  } as unknown as IExcerptCache
}

describe("resolveShareArtifact", () => {
  let pollSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    pollSpy = vi.spyOn(pollModule, "pollUntilReady").mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns the local cache hit without any HTTP", async () => {
    const cache = makeCache({ findLocal: vi.fn(async () => "file:///cached.pdf") })
    const result = await resolveShareArtifact({
      cache,
      filename: "f.pdf",
      predictedUrl: "https://cdn/p.pdf",
      cut: vi.fn(),
    })
    expect(result).toBe("file:///cached.pdf")
    expect(cache.download).not.toHaveBeenCalled()
    expect(pollSpy).not.toHaveBeenCalled()
  })

  it("downloads the warm CDN hit without cutting or polling", async () => {
    const cut = vi.fn()
    const cache = makeCache({ probeRemote: vi.fn(async () => true) })
    await resolveShareArtifact({
      cache,
      filename: "f.pdf",
      predictedUrl: "https://cdn/p.pdf",
      cut,
    })
    expect(cut).not.toHaveBeenCalled()
    expect(pollSpy).not.toHaveBeenCalled()
    expect(cache.download).toHaveBeenCalledWith({ url: "https://cdn/p.pdf", filename: "f.pdf" })
  })

  it("on a ready:false cut, polls the predicted URL with the given pollTimeoutMs", async () => {
    const cache = makeCache()
    await resolveShareArtifact({
      cache,
      filename: "f.pdf",
      predictedUrl: "https://cdn/p.pdf",
      cut: vi.fn(async () => ({ url: "", ready: false })),
      pollTimeoutMs: pollModule.SHORT_POLL_TIMEOUT_MS,
    })
    expect(pollSpy).toHaveBeenCalledWith("https://cdn/p.pdf", {
      timeoutMs: pollModule.SHORT_POLL_TIMEOUT_MS,
    })
  })

  it("defaults to the 8-min budget (undefined timeoutMs) when pollTimeoutMs is omitted", async () => {
    const cache = makeCache()
    await resolveShareArtifact({
      cache,
      filename: "v.mp4",
      predictedUrl: "https://cdn/v.mp4",
      // void result (video renderer dispatch) → poll the predicted URL
      cut: vi.fn(async () => undefined),
    })
    expect(pollSpy).toHaveBeenCalledWith("https://cdn/v.mp4", { timeoutMs: undefined })
  })

  it("skips the poll when the cut returns ready:true", async () => {
    const cache = makeCache()
    await resolveShareArtifact({
      cache,
      filename: "f.pdf",
      predictedUrl: "https://cdn/p.pdf",
      cut: vi.fn(async () => ({ url: "https://cdn/fresh.pdf", ready: true })),
      pollTimeoutMs: pollModule.SHORT_POLL_TIMEOUT_MS,
    })
    expect(pollSpy).not.toHaveBeenCalled()
    expect(cache.download).toHaveBeenCalledWith({
      url: "https://cdn/fresh.pdf",
      filename: "f.pdf",
    })
  })
})
