import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"

const loadTranscript = vi.fn()

vi.mock("@usecases/playback/loadTranscript.js", () => ({
  loadTranscript: (...args: unknown[]) => loadTranscript(...args) as unknown,
}))

const { useTranscriptLoader } = await import("../useTranscriptLoader.js")

const TRACK_ID = "t1" as TrackId
const EN = "en" as LanguageCode
const repo = {} as ITranscriptRepository

function loader() {
  return useTranscriptLoader({ getTranscripts: () => repo })
}

const transcript = { trackId: TRACK_ID, language: EN, version: 1, blocks: [] }

describe("useTranscriptLoader.reload — error lifecycle", () => {
  beforeEach(() => {
    loadTranscript.mockReset()
  })

  it("records a failed document read", async () => {
    loadTranscript.mockResolvedValue({ ok: false, error: "io-error" })
    const l = loader()

    await l.reload(TRACK_ID, [EN])

    expect(l.error.value).toBe("Transcript failed to load: io-error")
  })

  it("treats a missing transcript as an empty load, not an error", async () => {
    loadTranscript.mockResolvedValue({ ok: false, error: "no-transcript-available" })
    const l = loader()

    await l.reload(TRACK_ID, [EN])

    expect(l.error.value).toBeNull()
    expect(l.transcripts.value).toEqual([])
  })

  it("clears a previous failure when the transcript loads on a retry", async () => {
    // The reader renders the error state instead of the text while `error` is
    // set, and `reload` only ever ASSIGNED it — so a recovered read left the
    // page blank until the dialog was closed and re-opened (issue #1583).
    const l = loader()
    loadTranscript.mockResolvedValue({ ok: false, error: "io-error" })
    await l.reload(TRACK_ID, [EN])
    expect(l.error.value).not.toBeNull()

    loadTranscript.mockResolvedValue({ ok: true, value: { transcript } })
    await l.reload(TRACK_ID, [EN])

    expect(l.error.value).toBeNull()
    expect(l.transcripts.value).toHaveLength(1)
  })

  it("clears a previous failure when the dialog is emptied", async () => {
    const l = loader()
    loadTranscript.mockResolvedValue({ ok: false, error: "io-error" })
    await l.reload(TRACK_ID, [EN])

    await l.reload(undefined, [])

    expect(l.error.value).toBeNull()
  })
})
