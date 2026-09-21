import { describe, expect, it, vi } from "vitest"
import type {
  LibraryItemRow,
  ListeningSessionRow,
  MediaItemRow,
  NoteRow,
  PlaylistItemRow,
} from "@lib/persistence/user"
import {
  parseRefsJson,
  parseVariantsJson,
  rowToLibraryItem,
  rowToListeningSession,
  rowToMediaItem,
  rowToNote,
  rowToPlaylistItem,
} from "../rowMappers.js"

function noteRow(over: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "n1",
    track_id: "t1",
    text: "a thought",
    time_start: 10,
    time_end: 20,
    created_at: 1700000000000,
    meta: null,
    ...over,
  }
}

function libraryRow(over: Partial<LibraryItemRow> = {}): LibraryItemRow {
  return {
    id: "lib1",
    track_id: null,
    status: "ready",
    origin: "private",
    title_raw: "A lecture",
    author_raw: null,
    location_raw: null,
    date_raw: null,
    lang_hint: null,
    author_id: null,
    location_id: null,
    date: null,
    lang: null,
    error: null,
    audio_key: null,
    transcript_key: null,
    variants_json: null,
    duration: null,
    cover_key: null,
    references_json: null,
    source_url: null,
    created_at: null,
    updated_at: null,
    ...over,
  }
}

function mediaRow(over: Partial<MediaItemRow> = {}): MediaItemRow {
  return {
    id: "m1",
    track_id: "t1",
    kind: "original",
    state: "ready",
    local_path: "/data/t1.mp3",
    created_at: 1,
    ...over,
  }
}

describe("rowToNote", () => {
  it("carries the note's fields across", () => {
    expect(rowToNote(noteRow({ meta: null }))).toEqual({
      id: "n1",
      trackId: "t1",
      text: "a thought",
      timeStart: 10,
      timeEnd: 20,
      createdAt: 1700000000000,
      meta: null,
    })
  })

  it("parses a stored meta object", () => {
    const note = rowToNote(noteRow({ meta: JSON.stringify({ color: "amber" }) }))
    expect(note.meta).toEqual({ color: "amber" })
  })

  it("has no meta when the column is empty", () => {
    expect(rowToNote(noteRow({ meta: "" })).meta).toBeNull()
  })

  it("has no meta when the stored JSON is not an object", () => {
    expect(rowToNote(noteRow({ meta: "[1,2]" })).meta).toBeNull()
    expect(rowToNote(noteRow({ meta: "5" })).meta).toBeNull()
    expect(rowToNote(noteRow({ meta: "null" })).meta).toBeNull()
  })

  it("keeps the note when its meta is corrupt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const note = rowToNote(noteRow({ text: "still here", meta: "{oops" }))
    expect(note.text).toBe("still here")
    expect(note.meta).toBeNull()
    warn.mockRestore()
  })
})

describe("rowToPlaylistItem", () => {
  it("carries the item's fields across", () => {
    const row: PlaylistItemRow = {
      id: "pl1",
      track_id: "t1",
      added_at: 100,
      archived_at: 200,
      collection_id: "c1",
    }
    expect(rowToPlaylistItem(row)).toEqual({
      id: "pl1",
      trackId: "t1",
      addedAt: 100,
      archivedAt: 200,
      collectionId: "c1",
    })
  })

  it("has no collection when a pre-012 row lacks the column", () => {
    const row = { id: "pl1", track_id: "t1", added_at: 1, archived_at: null } as PlaylistItemRow
    expect(rowToPlaylistItem(row).collectionId).toBeNull()
  })
})

describe("rowToListeningSession", () => {
  it("carries the session's positions across", () => {
    const row: ListeningSessionRow = {
      id: "s1",
      item_id: "pl1",
      started_at: 10,
      ended_at: 40,
      from_position: 5,
      to_position: 35,
    }
    expect(rowToListeningSession(row)).toEqual({
      id: "s1",
      itemId: "pl1",
      startedAt: 10,
      endedAt: 40,
      fromPosition: 5,
      toPosition: 35,
    })
  })
})

describe("rowToMediaItem", () => {
  it("reads the two known kinds", () => {
    expect(rowToMediaItem(mediaRow({ kind: "clean" })).kind).toBe("clean")
    expect(rowToMediaItem(mediaRow({ kind: "original" })).kind).toBe("original")
  })

  it("treats a pre-011 row with no kind as the original audio", () => {
    expect(rowToMediaItem(mediaRow({ kind: null })).kind).toBe("original")
  })

  it("treats an unknown state as failed so the file is re-downloadable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(rowToMediaItem(mediaRow({ state: "uploading" })).state).toBe("failed")
    warn.mockRestore()
  })

  it("keeps each known state", () => {
    for (const state of ["pending", "downloading", "ready", "failed"] as const) {
      expect(rowToMediaItem(mediaRow({ state })).state).toBe(state)
    }
  })

  it("owes no eviction when a pre-026 row lacks the column", () => {
    expect(rowToMediaItem(mediaRow()).evictPending).toBe(false)
  })

  it("owes an eviction when the column is set", () => {
    expect(rowToMediaItem(mediaRow({ evict_pending: 1 })).evictPending).toBe(true)
    expect(rowToMediaItem(mediaRow({ evict_pending: 0 })).evictPending).toBe(false)
  })
})

describe("rowToLibraryItem", () => {
  it("renames the row's columns onto the domain item", () => {
    const item = rowToLibraryItem(
      libraryRow({
        track_id: "t1",
        author_raw: "A Speaker",
        date: "2024-01-02",
        lang: "ru",
        audio_key: "public/tracks/t1/audio/original.mp3",
        transcript_key: "public/tracks/t1/transcripts/ru.json",
        duration: 3600_000,
        cover_key: "covers/t1.jpg",
        source_url: "https://youtu.be/xyz",
        created_at: 10,
        updated_at: 20,
      })
    )
    expect(item).toMatchObject({
      id: "lib1",
      trackId: "t1",
      authorRaw: "A Speaker",
      date: "2024-01-02",
      lang: "ru",
      audioKey: "public/tracks/t1/audio/original.mp3",
      transcriptKey: "public/tracks/t1/transcripts/ru.json",
      duration: 3600_000,
      coverKey: "covers/t1.jpg",
      sourceUrl: "https://youtu.be/xyz",
      createdAt: 10,
      updatedAt: 20,
    })
  })

  it("keeps each known status", () => {
    for (const status of ["queued", "processing", "ready", "failed"] as const) {
      expect(rowToLibraryItem(libraryRow({ status })).status).toBe(status)
    }
  })

  it("shows a status a newer server wrote as still processing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(rowToLibraryItem(libraryRow({ status: "transcoding" })).status).toBe("processing")
    warn.mockRestore()
  })

  it("has no origin when the column is absent or unknown", () => {
    expect(rowToLibraryItem(libraryRow({ origin: null })).origin).toBeNull()
    expect(rowToLibraryItem(libraryRow({ origin: "shared" })).origin).toBeNull()
    expect(rowToLibraryItem(libraryRow({ origin: "published" })).origin).toBe("published")
  })

  it("maps the stored variants, renaming the outline spans", () => {
    const item = rowToLibraryItem(
      libraryRow({
        variants_json: JSON.stringify([
          {
            lang: "ru",
            title: "Лекция",
            transcript_key: "k/ru.json",
            description: "about karma",
            outline: [{ title: "Intro", start: 0, end: 1000 }],
          },
        ]),
      })
    )
    expect(item.variants).toEqual([
      {
        language: "ru",
        title: "Лекция",
        transcriptKey: "k/ru.json",
        description: "about karma",
        outline: [{ title: "Intro", startMs: 0, endMs: 1000 }],
      },
    ])
  })

  // The corpus outline has always been filtered; the library one reached the
  // same consumer unchecked, so an ingest could hand it a chapter no
  // at-time-T lookup would ever match.
  it.each([
    ["a bound that arrived as a string", { title: "Intro", start: 0, end: "1000" }],
    ["a span that ends where it starts", { title: "Intro", start: 500, end: 500 }],
    ["a span that runs backwards", { title: "Intro", start: 900, end: 100 }],
    ["a blank title", { title: "   ", start: 0, end: 1000 }],
    ["a missing end", { title: "Intro", start: 0 }],
    ["nothing at all", null],
  ])("drops an outline entry with %s", (_label, entry) => {
    const item = rowToLibraryItem(
      libraryRow({
        variants_json: JSON.stringify([
          { lang: "en", transcript_key: "k/en.json", outline: [entry] },
        ]),
      })
    )
    expect(item.variants[0].outline).toBeNull()
  })

  it("keeps the sound entries of a part-corrupt outline", () => {
    const item = rowToLibraryItem(
      libraryRow({
        variants_json: JSON.stringify([
          {
            lang: "en",
            transcript_key: "k/en.json",
            outline: [
              { title: "Intro", start: 0, end: 1000 },
              { title: "Broken", start: 900, end: 100 },
              { title: "Close", start: 1000, end: 2000 },
            ],
          },
        ]),
      })
    )
    expect(item.variants[0].outline).toEqual([
      { title: "Intro", startMs: 0, endMs: 1000 },
      { title: "Close", startMs: 1000, endMs: 2000 },
    ])
  })

  it("has no title, description or outline when a variant omits them", () => {
    const item = rowToLibraryItem(
      libraryRow({ variants_json: JSON.stringify([{ lang: "en", transcript_key: "k/en.json" }]) })
    )
    expect(item.variants[0]).toEqual({
      language: "en",
      title: null,
      transcriptKey: "k/en.json",
      description: null,
      outline: null,
    })
  })

  it("has no variants when the column is absent or malformed", () => {
    expect(rowToLibraryItem(libraryRow({ variants_json: null })).variants).toEqual([])
    expect(rowToLibraryItem(libraryRow({ variants_json: "{not json" })).variants).toEqual([])
    expect(rowToLibraryItem(libraryRow({ variants_json: '{"lang":"en"}' })).variants).toEqual([])
  })

  it("parses the stored references", () => {
    const item = rowToLibraryItem(
      libraryRow({ references_json: JSON.stringify([{ sourceId: "bg", tokens: ["2", "13"] }]) })
    )
    expect(item.references).toEqual([{ sourceId: "bg", tokens: ["2", "13"] }])
  })

  it("has no references when the column is absent or malformed", () => {
    expect(rowToLibraryItem(libraryRow({ references_json: null })).references).toEqual([])
    expect(rowToLibraryItem(libraryRow({ references_json: "oops" })).references).toEqual([])
    expect(
      rowToLibraryItem(libraryRow({ references_json: '{"sourceId":"bg"}' })).references
    ).toEqual([])
  })
})

describe("parseRefsJson", () => {
  it("reads a stored array", () => {
    expect(parseRefsJson('[{"sourceId":"sb","tokens":["1","1","1"]}]')).toEqual([
      { sourceId: "sb", tokens: ["1", "1", "1"] },
    ])
  })

  it("has nothing for an empty, unparseable or non-array column", () => {
    expect(parseRefsJson(null)).toBeNull()
    expect(parseRefsJson("")).toBeNull()
    expect(parseRefsJson("[")).toBeNull()
    expect(parseRefsJson("{}")).toBeNull()
  })
})

describe("parseVariantsJson", () => {
  it("reads the stored entries verbatim", () => {
    expect(parseVariantsJson('[{"lang":"en","transcript_key":"k"}]')).toEqual([
      { lang: "en", transcript_key: "k" },
    ])
  })

  it("has nothing for an empty, unparseable or non-array column", () => {
    expect(parseVariantsJson(null)).toBeNull()
    expect(parseVariantsJson("")).toBeNull()
    expect(parseVariantsJson("[{")).toBeNull()
    expect(parseVariantsJson('"en"')).toBeNull()
  })
})
