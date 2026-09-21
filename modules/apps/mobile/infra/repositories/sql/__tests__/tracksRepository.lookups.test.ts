import { beforeEach, describe, expect, it } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"

import { createSqlTrackRepository } from "../tracksRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/** The catalog columns the id/reference lookups and their hydration touch. */
async function applyContentSchema(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE tracks (
    id          TEXT PRIMARY KEY,
    author_id   TEXT,
    location_id TEXT,
    date        TEXT,
    hidden      INTEGER NOT NULL DEFAULT 0
  )`)
  await db.execute(`CREATE TABLE track_variants (
    track_id        TEXT NOT NULL,
    language        TEXT NOT NULL,
    title           TEXT NOT NULL,
    transcript_path TEXT,
    transcript_kind TEXT,
    sort_reference  TEXT,
    PRIMARY KEY (track_id, language)
  )`)
  await db.execute(`CREATE TABLE track_audio (
    track_id TEXT NOT NULL,
    language TEXT NOT NULL,
    kind     TEXT NOT NULL,
    path     TEXT NOT NULL,
    filesize INTEGER,
    duration INTEGER,
    PRIMARY KEY (track_id, language, kind)
  )`)
  await db.execute(`CREATE TABLE track_references (
    track_id  TEXT NOT NULL,
    ref_idx   INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    tokens    TEXT NOT NULL,
    PRIMARY KEY (track_id, ref_idx)
  )`)
  await db.execute(`CREATE TABLE track_tags (
    track_id TEXT, tag_id TEXT, PRIMARY KEY (track_id, tag_id)
  )`)
  await db.execute(`CREATE TABLE track_topics (
    track_id TEXT, topic_id TEXT, weight REAL, PRIMARY KEY (track_id, topic_id)
  )`)
}

interface VariantSeed {
  language: string
  title: string
  transcriptPath?: string | null
  duration?: number | null
}

interface TrackSeed {
  id: string
  date?: string | null
  hidden?: boolean
  variants: VariantSeed[]
  references?: Array<{ sourceId: string; tokens: string }>
}

async function seedTracks(db: IDatabase, tracks: readonly TrackSeed[]): Promise<void> {
  for (const t of tracks) {
    await db.execute(
      `INSERT INTO tracks (id, author_id, location_id, date, hidden) VALUES (?, NULL, NULL, ?, ?)`,
      [t.id, t.date ?? null, t.hidden ? 1 : 0]
    )
    for (const v of t.variants) {
      await db.execute(
        `INSERT INTO track_variants (track_id, language, title, transcript_path, transcript_kind, sort_reference)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [t.id, v.language, v.title, v.transcriptPath ?? null, v.transcriptPath ? "auto" : null]
      )
      if (v.duration !== undefined && v.duration !== null) {
        await db.execute(
          `INSERT INTO track_audio (track_id, language, kind, path, filesize, duration)
           VALUES (?, ?, 'original', ?, 1000, ?)`,
          [t.id, v.language, `public/tracks/${t.id}/audio/${v.language}.mp3`, v.duration]
        )
      }
    }
    const refs = t.references ?? []
    for (let i = 0; i < refs.length; i++) {
      await db.execute(
        `INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES (?, ?, ?, ?)`,
        [t.id, i, refs[i].sourceId, refs[i].tokens]
      )
    }
  }
}

const CORPUS: TrackSeed[] = [
  {
    id: "t-bg-2-13",
    date: "1974-11-01",
    variants: [
      { language: "en", title: "Eternality of the Soul", transcriptPath: "en/2-13.json" },
      { language: "ru", title: "Вечность души", duration: 3_600_000 },
    ],
    references: [
      { sourceId: "bg", tokens: "2.13" },
      { sourceId: "sb", tokens: "1.1.1" },
    ],
  },
  {
    id: "t-bg-2-13-ru-only",
    date: "1975-05-05",
    variants: [{ language: "ru", title: "Душа", duration: 1_800_000 }],
    references: [{ sourceId: "bg", tokens: "2.13" }],
  },
  {
    id: "t-hidden",
    date: "1976-01-01",
    hidden: true,
    variants: [{ language: "en", title: "Withdrawn", transcriptPath: "en/hidden.json" }],
    references: [{ sourceId: "bg", tokens: "9.9" }],
  },
]

const lang = (code: string): LanguageCode => code as LanguageCode
const trackId = (id: string): TrackId => id as TrackId
const sourceId = (id: string): SourceId => id as SourceId

describe("tracksRepository.sql — lookups", () => {
  let repo: ReturnType<typeof createSqlTrackRepository>

  beforeEach(async () => {
    const db = await createInMemoryTestDatabase()
    await applyContentSchema(db)
    await seedTracks(db, CORPUS)
    repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: () => lang("en") })
  })

  describe("getById", () => {
    it("returns the track with every language variant and reference attached", async () => {
      const track = await repo.getById(trackId("t-bg-2-13"))

      expect(track?.id).toBe("t-bg-2-13")
      expect(track?.variants.map((v) => v.language).sort()).toEqual(["en", "ru"])
      expect(track?.references).toHaveLength(2)
      expect(track?.references[0]).toMatchObject({ sourceId: "bg", tokens: ["2", "13"] })
    })

    it("returns null for an id nobody has", async () => {
      expect(await repo.getById(trackId("t-nope"))).toBeNull()
    })

    it("will not surface a hidden track", async () => {
      expect(await repo.getById(trackId("t-hidden"))).toBeNull()
    })
  })

  describe("getByIds", () => {
    it("keys the tracks it found by id and omits the ones it did not", async () => {
      const found = await repo.getByIds([
        trackId("t-bg-2-13"),
        trackId("t-nope"),
        trackId("t-bg-2-13-ru-only"),
      ])

      expect([...found.keys()].sort()).toEqual(["t-bg-2-13", "t-bg-2-13-ru-only"])
      expect(found.get(trackId("t-bg-2-13"))?.variants).toHaveLength(2)
    })

    it("asks the database nothing for an empty id list", async () => {
      expect((await repo.getByIds([])).size).toBe(0)
    })

    it("omits a hidden track even when asked for it by id", async () => {
      const found = await repo.getByIds([trackId("t-hidden"), trackId("t-bg-2-13")])

      expect([...found.keys()]).toEqual(["t-bg-2-13"])
    })
  })

  describe("findByReference", () => {
    it("finds a track by a non-leading reference of its own", async () => {
      const track = await repo.findByReference(sourceId("sb"), ["1", "1", "1"])

      expect(track?.id).toBe("t-bg-2-13")
    })

    it("returns null when no track carries the reference", async () => {
      expect(await repo.findByReference(sourceId("bg"), ["18", "66"])).toBeNull()
    })

    it("does not answer with a hidden track", async () => {
      expect(await repo.findByReference(sourceId("bg"), ["9", "9"])).toBeNull()
    })

    it("restricts the pick to the reader's library languages", async () => {
      const track = await repo.findByReference(sourceId("bg"), ["2", "13"], [lang("en")])

      // Both tracks carry BG 2.13, so the arbitrary LIMIT 1 could land on
      // either — only one of them has an English variant to play.
      expect(track?.id).toBe("t-bg-2-13")
    })

    it("finds nothing when the reference exists in no requested language", async () => {
      expect(await repo.findByReference(sourceId("sb"), ["1", "1", "1"], [lang("de")])).toBeNull()
    })

    it("treats an empty language list as no language restriction", async () => {
      const track = await repo.findByReference(sourceId("sb"), ["1", "1", "1"], [])

      expect(track?.id).toBe("t-bg-2-13")
    })
  })

  describe("getTranscriptPath", () => {
    it("returns the stored path for that track and language", async () => {
      expect(await repo.getTranscriptPath(trackId("t-bg-2-13"), lang("en"))).toBe("en/2-13.json")
    })

    it("returns null for a variant that has no transcript", async () => {
      expect(await repo.getTranscriptPath(trackId("t-bg-2-13"), lang("ru"))).toBeNull()
    })

    it("returns null for a language the track has no variant in", async () => {
      expect(await repo.getTranscriptPath(trackId("t-bg-2-13"), lang("de"))).toBeNull()
    })
  })

  describe("listTranscriptLanguages", () => {
    it("lists only the languages that actually have a transcript", async () => {
      expect(await repo.listTranscriptLanguages(trackId("t-bg-2-13"))).toEqual(["en"])
    })

    it("returns nothing for a track with no transcript at all", async () => {
      expect(await repo.listTranscriptLanguages(trackId("t-bg-2-13-ru-only"))).toEqual([])
    })
  })

  describe("getDurationsMs", () => {
    it("reports the longest audio a track has", async () => {
      const durations = await repo.getDurationsMs([
        trackId("t-bg-2-13"),
        trackId("t-bg-2-13-ru-only"),
      ])

      expect(durations.get(trackId("t-bg-2-13"))).toBe(3_600_000)
      expect(durations.get(trackId("t-bg-2-13-ru-only"))).toBe(1_800_000)
    })

    it("omits a track with no audio rather than reporting it as zero-length", async () => {
      const durations = await repo.getDurationsMs([trackId("t-hidden"), trackId("t-nope")])

      expect(durations.size).toBe(0)
    })

    it("returns an empty map for no input", async () => {
      expect((await repo.getDurationsMs([])).size).toBe(0)
    })
  })
})
