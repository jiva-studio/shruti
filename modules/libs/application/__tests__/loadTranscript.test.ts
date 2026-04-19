import { describe, expect, it } from "vitest"
import { loadTranscript } from "../loadTranscript.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { Transcript } from "@lib/domain/transcript.js"

function makeTranscripts(
  overrides: Partial<ITranscriptRepository> = {}
): ITranscriptRepository {
  return {
    get: async () => {
      throw new Error("get not stubbed")
    },
    has: async () => false,
    availableLanguages: async () => [],
    ...overrides,
  }
}

const sampleTranscript: Transcript = {
  trackId: "t1",
  language: "ru",
  version: 1,
  blocks: [
    { type: "paragraph", start: 0, end: 1 },
    { type: "sentence", start: 1, end: 2, text: "Hello" },
  ],
}

describe("loadTranscript", () => {
  it("returns the preferred language when available", async () => {
    const transcripts = makeTranscripts({
      availableLanguages: async () => ["en", "ru"],
      get: async () => sampleTranscript,
    })
    const result = await loadTranscript(
      { trackId: "t1", preferredLanguage: "ru" },
      { transcripts }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.matchesPreferred).toBe(true)
      expect(result.value.availableLanguages).toEqual(["en", "ru"])
    }
  })

  it("falls back to the first language when the preferred one is missing", async () => {
    const transcripts = makeTranscripts({
      availableLanguages: async () => ["en"],
      get: async () => ({ ...sampleTranscript, language: "en" }),
    })
    const result = await loadTranscript(
      { trackId: "t1", preferredLanguage: "ru" },
      { transcripts }
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.matchesPreferred).toBe(false)
      expect(result.value.transcript.language).toBe("en")
    }
  })

  it("returns no-transcript-available when language list is empty", async () => {
    const transcripts = makeTranscripts({ availableLanguages: async () => [] })
    const result = await loadTranscript(
      { trackId: "t1", preferredLanguage: "ru" },
      { transcripts }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("no-transcript-available")
  })

  it("returns fetch-failed when the repository throws", async () => {
    const transcripts = makeTranscripts({
      availableLanguages: async () => ["ru"],
      get: async () => {
        throw new Error("boom")
      },
    })
    const result = await loadTranscript(
      { trackId: "t1", preferredLanguage: "ru" },
      { transcripts }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("fetch-failed")
  })
})
