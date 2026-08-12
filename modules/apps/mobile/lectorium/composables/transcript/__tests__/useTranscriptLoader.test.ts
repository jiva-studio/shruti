import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"

const loadTranscript = vi.fn()

vi.mock("@usecases/playback/loadTranscript.js", () => ({
  loadTranscript: (...args: unknown[]) => loadTranscript(...args) as unknown,
}))

const { useTranscriptLoader } = await import("../useTranscriptLoader.js")

const TRACK_ID = "t1" as TrackId
const OTHER_TRACK_ID = "t2" as TrackId
const EN = "en" as LanguageCode
const RU = "ru" as LanguageCode
const repo = {} as ITranscriptRepository

/** A result that stays pending until the test resolves it — lets two loads
 *  overlap so the stale one can try to land after the fresh one. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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

/**
 * The failure of ONE language used to be written straight to `error` from
 * inside the per-language callback — before the token guard and without
 * consulting it (issue #1785). Both halves of that are asserted here: a
 * failure must not cost the reader the language that did load, and a failure
 * belonging to a load nobody is waiting for any more must not land at all.
 */
describe("useTranscriptLoader.reload — partial and stale loads", () => {
  beforeEach(() => {
    loadTranscript.mockReset()
  })

  it("keeps the language that loaded when another one fails", async () => {
    loadTranscript.mockImplementation((input: unknown) =>
      (input as { preferredLanguage: LanguageCode }).preferredLanguage === RU
        ? Promise.resolve({ ok: true, value: { transcript } })
        : Promise.resolve({ ok: false, error: "io-error" })
    )
    const l = loader()

    await l.reload(TRACK_ID, [RU, EN])

    expect(l.error.value).toBeNull()
    expect(l.transcripts.value).toHaveLength(1)
    expect(l.transcripts.value[0]!.language).toBe(RU)
    expect(l.failedLanguages.value).toEqual([EN])
  })

  it("takes the reader to its error state only when nothing loaded", async () => {
    loadTranscript.mockResolvedValue({ ok: false, error: "io-error" })
    const l = loader()

    await l.reload(TRACK_ID, [RU, EN])

    expect(l.error.value).toBe("Transcript failed to load: io-error")
    expect(l.failedLanguages.value).toEqual([])
  })

  it("drops a stale load's failure instead of overwriting a newer load", async () => {
    const stale = deferred<unknown>()
    loadTranscript.mockImplementation((input: unknown) =>
      (input as { trackId: TrackId }).trackId === TRACK_ID
        ? stale.promise
        : Promise.resolve({ ok: true, value: { transcript } })
    )
    const l = loader()

    const first = l.reload(TRACK_ID, [EN])
    await l.reload(OTHER_TRACK_ID, [EN])
    stale.resolve({ ok: false, error: "io-error" })
    await first

    expect(l.error.value).toBeNull()
    expect(l.failedLanguages.value).toEqual([])
    expect(l.transcripts.value).toHaveLength(1)
    expect(l.isLoading.value).toBe(false)
  })

  it("invalidates an in-flight load when the dialog is emptied", async () => {
    const pending = deferred<unknown>()
    loadTranscript.mockReturnValue(pending.promise)
    const l = loader()

    const first = l.reload(TRACK_ID, [EN])
    await l.reload(undefined, [])
    expect(l.isLoading.value).toBe(false)

    pending.resolve({ ok: true, value: { transcript } })
    await first

    expect(l.transcripts.value).toEqual([])
    expect(l.isLoading.value).toBe(false)
  })
})
