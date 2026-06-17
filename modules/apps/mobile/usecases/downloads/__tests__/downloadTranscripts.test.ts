import { describe, expect, it, vi } from "vitest"
import { downloadTranscripts } from "../downloadTranscripts.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"

function makeRepo(
  langs: readonly LanguageCode[] | (() => Promise<readonly LanguageCode[]>)
): ITranscriptRepository {
  return {
    get: async () => {
      throw new Error("get not stubbed")
    },
    has: async () => false,
    availableLanguages: typeof langs === "function" ? langs : async () => langs,
  }
}

describe("downloadTranscripts", () => {
  it("transfers every advertised language and reports them as cached", async () => {
    const transfer = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockResolvedValue(undefined)
    const repo = makeRepo(["en", "ru"] as readonly LanguageCode[])
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.cached).toEqual(["en", "ru"])
      expect(result.value.failed).toEqual([])
    }
    expect(transfer).toHaveBeenCalledTimes(2)
    expect(transfer).toHaveBeenNthCalledWith(1, "t-1", "en")
    expect(transfer).toHaveBeenNthCalledWith(2, "t-1", "ru")
  })

  it("filters to the explicit languages list when provided", async () => {
    const transfer = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockResolvedValue(undefined)
    const repo = makeRepo(["en", "ru", "es"] as readonly LanguageCode[])
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId, languages: ["ru"] as readonly LanguageCode[] },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.cached).toEqual(["ru"])
    expect(transfer).toHaveBeenCalledTimes(1)
    expect(transfer).toHaveBeenCalledWith("t-1", "ru")
  })

  it("treats an empty languages list as 'no allow-list' (downloads everything)", async () => {
    const transfer = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockResolvedValue(undefined)
    const repo = makeRepo(["en"] as readonly LanguageCode[])
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId, languages: [] },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.cached).toEqual(["en"])
  })

  it("returns list-failed when availableLanguages throws", async () => {
    const transfer = vi.fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
    const repo = makeRepo(async () => {
      throw new Error("db locked")
    })
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("list-failed")
    expect(transfer).not.toHaveBeenCalled()
  })

  it("collects per-language failures without aborting other languages", async () => {
    const transfer = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockImplementation(async (_id, language) => {
        if (language === "ru") throw new Error("404")
      })
    const repo = makeRepo(["en", "ru", "es"] as readonly LanguageCode[])
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.cached).toEqual(["en", "es"])
      expect(result.value.failed).toEqual(["ru"])
    }
    // All three were attempted — `failed` is a collection step, not a fatal exit.
    expect(transfer).toHaveBeenCalledTimes(3)
  })

  it("returns an empty outcome when the track has no advertised transcripts", async () => {
    const transfer = vi.fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
    const repo = makeRepo([] as readonly LanguageCode[])
    const result = await downloadTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, transfer }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.cached).toEqual([])
      expect(result.value.failed).toEqual([])
    }
    expect(transfer).not.toHaveBeenCalled()
  })
})
