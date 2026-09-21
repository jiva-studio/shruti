import { describe, expect, it } from "vitest"
import type {
  AuthorRow,
  LanguageRow,
  LocationRow,
  SourceRow,
  TagRow,
  TopicRow,
  TrackAudioRow,
  TrackRow,
  TrackVariantRow,
} from "@lib/persistence/main"
import {
  foldDictRows,
  narrowAudioKind,
  rowToAuthor,
  rowToLanguage,
  rowToLocation,
  rowToSource,
  rowToTag,
  rowToTopic,
  rowToTrack,
  rowToTrackVariant,
  type TrackAssemblyParts,
} from "../contentRowMappers.js"

function audioRow(over: Partial<TrackAudioRow> = {}): TrackAudioRow {
  return {
    track_id: "t1",
    language: "en",
    kind: "original",
    path: "tracks/t1/en/original.mp3",
    filesize: 1024,
    duration: 60_000,
    ...over,
  }
}

function variantRow(over: Partial<TrackVariantRow> = {}): TrackVariantRow {
  return {
    track_id: "t1",
    language: "en",
    title: "A lecture",
    transcript_path: null,
    transcript_kind: null,
    sort_reference: null,
    outline: null,
    description: null,
    ...over,
  }
}

function parts(over: Partial<TrackAssemblyParts> = {}): TrackAssemblyParts {
  const track: TrackRow = {
    id: "t1",
    author_id: "a1",
    location_id: "l1",
    date: "2024-01-02",
    hidden: 0,
  }
  return {
    track,
    variants: [],
    audios: [],
    references: [],
    tags: [],
    topics: [],
    ...over,
  }
}

describe("dict row folds", () => {
  it("folds one author's per-locale rows into a name map", () => {
    const rows: AuthorRow[] = [
      { id: "a1", language: "en", full_name: "Author" },
      { id: "a1", language: "ru", full_name: "Автор" },
    ]
    const author = rowToAuthor(rows)
    expect(author.id).toBe("a1")
    expect(author.names.get("ru")).toBe("Автор")
    expect(author.names.get("en")).toBe("Author")
  })

  it("folds a location the same way", () => {
    const rows: LocationRow[] = [{ id: "l1", language: "en", full_name: "Vrindavan" }]
    expect(rowToLocation(rows).names.get("en")).toBe("Vrindavan")
  })

  it("keeps a source's full and short name per locale", () => {
    const rows: SourceRow[] = [
      { id: "bg", language: "en", full_name: "Bhagavad-gita", short_name: "BG" },
      { id: "bg", language: "ru", full_name: "Бхагавад-гита", short_name: "БГ" },
    ]
    expect(rowToSource(rows).names.get("ru")).toEqual({
      fullName: "Бхагавад-гита",
      shortName: "БГ",
    })
  })

  it("folds a tag the same way", () => {
    const rows: TagRow[] = [{ id: "tag1", language: "en", full_name: "Featured" }]
    expect(rowToTag(rows).names.get("en")).toBe("Featured")
  })

  it("reads a language row", () => {
    const row: LanguageRow = { code: "ru", full_name: "Русский", icon: "ru.svg" }
    expect(rowToLanguage(row)).toEqual({ code: "ru", fullName: "Русский", icon: "ru.svg" })
  })

  it("has no icon when the column is null", () => {
    expect(rowToLanguage({ code: "en", full_name: "English", icon: null }).icon).toBeNull()
  })

  it("keeps a topic's short names and takes the first cover it finds", () => {
    const rows: TopicRow[] = [
      { id: "tp1", language: "en", full_name: "Karma", short_name: null, cover: null },
      { id: "tp1", language: "ru", full_name: "Карма", short_name: "Карма", cover: "karma.jpg" },
    ]
    const topic = rowToTopic(rows)
    expect(topic.names.get("en")).toBe("Karma")
    expect(topic.shortNames.has("en")).toBe(false)
    expect(topic.shortNames.get("ru")).toBe("Карма")
    expect(topic.cover).toBe("karma.jpg")
  })

  it("has no cover when no locale carries one", () => {
    const rows: TopicRow[] = [{ id: "tp1", language: "en", full_name: "Karma" }]
    expect(rowToTopic(rows).cover).toBeNull()
  })

  it("groups a mixed-id result set by id", () => {
    const rows: AuthorRow[] = [
      { id: "a1", language: "en", full_name: "One" },
      { id: "a2", language: "en", full_name: "Two" },
      { id: "a1", language: "ru", full_name: "Один" },
    ]
    const byId = foldDictRows(rows, rowToAuthor)
    expect([...byId.keys()]).toEqual(["a1", "a2"])
    expect(byId.get("a1")?.names.size).toBe(2)
    expect(byId.get("a2")?.names.get("en")).toBe("Two")
  })
})

describe("narrowAudioKind", () => {
  it("reads the clean kind", () => {
    expect(narrowAudioKind("clean")).toBe("clean")
  })

  it("reads anything else as the original", () => {
    expect(narrowAudioKind("original")).toBe("original")
    expect(narrowAudioKind("denoised")).toBe("original")
    expect(narrowAudioKind("")).toBe("original")
  })
})

describe("rowToTrackVariant", () => {
  it("takes only the audio of its own track and language", () => {
    const variant = rowToTrackVariant(variantRow(), [
      audioRow({ path: "mine.mp3" }),
      audioRow({ language: "ru", path: "other-language.mp3" }),
      audioRow({ track_id: "t2", path: "other-track.mp3" }),
    ])
    expect(variant.audios.map((a) => a.path)).toEqual(["mine.mp3"])
  })

  it("prefers the clean audio for playback", () => {
    const variant = rowToTrackVariant(variantRow(), [
      audioRow({ kind: "original", path: "original.mp3" }),
      audioRow({ kind: "clean", path: "clean.mp3" }),
    ])
    expect(variant.audio?.path).toBe("clean.mp3")
  })

  it("has no playable audio when the track has none", () => {
    expect(rowToTrackVariant(variantRow(), []).audio).toBeNull()
  })

  it("has no duration or filesize when the columns are null", () => {
    const variant = rowToTrackVariant(variantRow(), [audioRow({ duration: null, filesize: null })])
    expect(variant.audios[0].duration).toBeNull()
    expect(variant.audios[0].filesize).toBeNull()
  })

  it("has no transcript when the path is null", () => {
    expect(rowToTrackVariant(variantRow({ transcript_path: null }), []).transcript).toBeNull()
  })

  it("reads a transcript's kind", () => {
    const variant = rowToTrackVariant(
      variantRow({ transcript_path: "t.json", transcript_kind: "generated" }),
      []
    )
    expect(variant.transcript).toEqual({ path: "t.json", kind: "generated" })
  })

  it("calls a transcript of an unknown or missing kind an original", () => {
    expect(
      rowToTrackVariant(variantRow({ transcript_path: "t.json", transcript_kind: "revised" }), [])
        .transcript?.kind
    ).toBe("original")
    expect(
      rowToTrackVariant(variantRow({ transcript_path: "t.json", transcript_kind: null }), [])
        .transcript?.kind
    ).toBe("original")
  })

  it("parses the stored outline and description", () => {
    const variant = rowToTrackVariant(
      variantRow({
        outline: JSON.stringify([{ title: "Intro", start: 0, end: 500 }]),
        description: "an overview",
      }),
      []
    )
    expect(variant.outline).toEqual([{ title: "Intro", startMs: 0, endMs: 500 }])
    expect(variant.description).toBe("an overview")
  })
})

describe("rowToTrack", () => {
  it("assembles the track's variants from its own rows only", () => {
    const track = rowToTrack(
      parts({
        variants: [
          variantRow(),
          variantRow({ language: "ru", title: "Лекция" }),
          variantRow({ track_id: "t2" }),
        ],
        audios: [audioRow()],
      })
    )
    expect(track.variants.map((v) => v.language)).toEqual(["en", "ru"])
  })

  it("orders the references by their stored index and splits the tokens", () => {
    const track = rowToTrack(
      parts({
        references: [
          { track_id: "t1", ref_idx: 1, source_id: "sb", tokens: "5.5.3" },
          { track_id: "t1", ref_idx: 0, source_id: "bg", tokens: "2.13" },
          { track_id: "t2", ref_idx: 0, source_id: "cc", tokens: "1.1" },
        ],
      })
    )
    expect(track.references).toEqual([
      { sourceId: "bg", tokens: ["2", "13"] },
      { sourceId: "sb", tokens: ["5", "5", "3"] },
    ])
  })

  it("has no tokens for a whole-book reference", () => {
    const track = rowToTrack(
      parts({ references: [{ track_id: "t1", ref_idx: 0, source_id: "bg", tokens: "" }] })
    )
    expect(track.references).toEqual([{ sourceId: "bg", tokens: [] }])
  })

  it("orders the topics by weight, heaviest first", () => {
    const track = rowToTrack(
      parts({
        topics: [
          { track_id: "t1", topic_id: "light", weight: 1 },
          { track_id: "t1", topic_id: "heavy", weight: 9 },
          { track_id: "t2", topic_id: "elsewhere", weight: 99 },
        ],
      })
    )
    expect(track.topicIds).toEqual(["heavy", "light"])
  })

  it("takes only its own tags", () => {
    const track = rowToTrack(
      parts({
        tags: [
          { track_id: "t1", tag_id: "mine" },
          { track_id: "t2", tag_id: "theirs" },
        ],
      })
    )
    expect(track.tagIds).toEqual(["mine"])
  })

  it("reads the hidden column as a flag", () => {
    expect(rowToTrack(parts()).hidden).toBe(false)
    const hidden = { ...parts().track, hidden: 1 }
    expect(rowToTrack(parts({ track: hidden })).hidden).toBe(true)
  })

  it("carries a track with no author, location or date", () => {
    const bare: TrackRow = { id: "t1", author_id: null, location_id: null, date: null, hidden: 0 }
    const track = rowToTrack(parts({ track: bare }))
    expect(track).toMatchObject({ id: "t1", authorId: null, locationId: null, date: null })
  })
})
