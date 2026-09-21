import { describe, expect, it, vi } from "vitest"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { saveCitationAsNote, type SaveCitationAsNoteDeps } from "../saveCitationAsNote.js"

const TRACK = "t1" as TrackId

function sentence(start: number, end: number, text: string) {
  return { type: "sentence", start, end, text }
}

function transcripts(blocks: unknown[] | Error = []): SaveCitationAsNoteDeps["transcripts"] {
  return {
    availableLanguages: async () => (blocks instanceof Error ? [] : (["en"] as LanguageCode[])),
    get: async () => {
      if (blocks instanceof Error) throw blocks
      return { blocks }
    },
    has: async () => true,
  } as never
}

function notes(): { deps: SaveCitationAsNoteDeps["notes"]; written: Note[] } {
  const written: Note[] = []
  const deps = {
    create: vi.fn(async (input: Omit<Note, "id">) => {
      const note = { id: `n${written.length + 1}`, ...input } as Note
      written.push(note)
      return note
    }),
  } as never
  return { deps, written }
}

const input = {
  trackId: TRACK,
  startMs: 1000,
  endMs: 2000,
  caption: "On the soul",
  preferredLanguage: "en" as LanguageCode,
}

describe("saveCitationAsNote", () => {
  it("prefers the server's own snippet over the local transcript", async () => {
    const n = notes()
    const result = await saveCitationAsNote(
      { ...input, text: "  the exact fragment  " },
      { notes: n.deps, transcripts: transcripts([sentence(1000, 2000, "local words")]) }
    )
    expect(result.ok).toBe(true)
    expect(n.written[0].text).toBe("the exact fragment")
  })

  it("quotes the spoken words, not the chip caption, when it can", async () => {
    const n = notes()
    await saveCitationAsNote(input, {
      notes: n.deps,
      transcripts: transcripts([
        sentence(0, 900, "before"),
        sentence(1000, 1500, "the soul is eternal"),
        sentence(1600, 2000, "and never dies"),
        sentence(2100, 3000, "after"),
      ]),
    })
    expect(n.written[0].text).toBe("the soul is eternal and never dies")
  })

  it("falls back to the caption when the transcript is unavailable", async () => {
    const n = notes()
    await saveCitationAsNote(input, {
      notes: n.deps,
      transcripts: transcripts(new Error("no transcript")),
    })
    expect(n.written[0].text).toBe("On the soul")
  })

  it("falls back to the caption when the span holds no words", async () => {
    const n = notes()
    await saveCitationAsNote(input, {
      notes: n.deps,
      transcripts: transcripts([sentence(5000, 6000, "elsewhere")]),
    })
    expect(n.written[0].text).toBe("On the soul")
  })

  it("refuses rather than saving a blank note", async () => {
    const n = notes()
    const result = await saveCitationAsNote(
      { ...input, caption: "   " },
      { notes: n.deps, transcripts: transcripts([]) }
    )
    expect(result).toMatchObject({ ok: false, error: "empty-text" })
    expect(n.written).toHaveLength(0)
  })

  it("keeps the span the note is anchored to", async () => {
    const n = notes()
    await saveCitationAsNote({ ...input, text: "x" }, { notes: n.deps, transcripts: transcripts() })
    expect(n.written[0]).toMatchObject({ trackId: TRACK, timeStart: 1000, timeEnd: 2000 })
  })

  it("normalises a negative start and an end before the start", async () => {
    const n = notes()
    await saveCitationAsNote(
      { ...input, startMs: -500, endMs: -900, text: "x" },
      { notes: n.deps, transcripts: transcripts() }
    )
    expect(n.written[0]).toMatchObject({ timeStart: 0, timeEnd: 0 })
  })

  it("reports the write failure rather than pretending it saved", async () => {
    const result = await saveCitationAsNote(
      { ...input, text: "x" },
      {
        notes: {
          create: async () => {
            throw new Error("disk full")
          },
        } as never,
        transcripts: transcripts(),
      }
    )
    expect(result).toMatchObject({ ok: false, error: "create-note-failed" })
  })
})
