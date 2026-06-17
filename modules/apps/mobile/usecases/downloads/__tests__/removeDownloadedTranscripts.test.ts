import { describe, expect, it, vi } from "vitest"
import { removeDownloadedTranscripts } from "../removeDownloadedTranscripts.js"
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

describe("removeDownloadedTranscripts", () => {
  it("invokes deleteLocal for every advertised language", async () => {
    const deleteLocal = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockResolvedValue(undefined)
    const repo = makeRepo(["en", "ru"] as readonly LanguageCode[])
    const result = await removeDownloadedTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toEqual(["en", "ru"])
    expect(deleteLocal).toHaveBeenCalledTimes(2)
    expect(deleteLocal).toHaveBeenNthCalledWith(1, "t-1", "en")
    expect(deleteLocal).toHaveBeenNthCalledWith(2, "t-1", "ru")
  })

  it("tolerates a single deleteLocal throw and keeps removing the rest", async () => {
    // Real-world: file already evicted by a previous Settings → Clear cache.
    // The orphan should not abort the rest of the loop.
    const deleteLocal = vi
      .fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
      .mockImplementation(async (_id, language) => {
        if (language === "ru") throw new Error("not found")
      })
    const repo = makeRepo(["en", "ru", "es"] as readonly LanguageCode[])
    const result = await removeDownloadedTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    // `removed` only counts successes — the failed delete is not lying about
    // bytes still being on disk.
    if (result.ok) expect(result.value.removed).toEqual(["en", "es"])
    expect(deleteLocal).toHaveBeenCalledTimes(3)
  })

  it("returns an empty 'removed' when languages query throws (best-effort cleanup)", async () => {
    const deleteLocal = vi.fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
    const repo = makeRepo(async () => {
      throw new Error("db locked")
    })
    const result = await removeDownloadedTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, deleteLocal }
    )
    // Critically: this is `ok`, not `err`. The audio remove path must never
    // be blocked by an unreachable content DB.
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toEqual([])
    expect(deleteLocal).not.toHaveBeenCalled()
  })

  it("succeeds with empty 'removed' when track has no advertised transcripts", async () => {
    const deleteLocal = vi.fn<(trackId: TrackId, language: LanguageCode) => Promise<void>>()
    const repo = makeRepo([] as readonly LanguageCode[])
    const result = await removeDownloadedTranscripts(
      { trackId: "t-1" as TrackId },
      { transcripts: repo, deleteLocal }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toEqual([])
    expect(deleteLocal).not.toHaveBeenCalled()
  })
})
