import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import { createSqlTrackRepository } from "../tracksRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Minimal content-DB schema for the search tests.
 *
 * Mirrors the catalog wire-schema owned by `modules/tools/shruti-mcp`
 * (the Go service that writes `current.db`) for the columns / FTS table
 * the repo touches. Kept inline so this infra test doesn't reach across
 * package boundaries.
 */
async function applyContentSchemaForTests(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE sources (
    id         TEXT NOT NULL,
    language   TEXT NOT NULL,
    full_name  TEXT NOT NULL,
    short_name TEXT NOT NULL,
    PRIMARY KEY (id, language)
  )`)
  await db.execute(`CREATE TABLE tracks (
    id              TEXT PRIMARY KEY,
    author_id       TEXT,
    location_id     TEXT,
    date            TEXT,
    hidden          INTEGER NOT NULL DEFAULT 0,
    sort_reference  TEXT NOT NULL,
    sort_date       TEXT NOT NULL
  )`)
  await db.execute(`CREATE TABLE track_variants (
    track_id         TEXT NOT NULL,
    language         TEXT NOT NULL,
    title            TEXT NOT NULL COLLATE NOCASE,
    audio_path       TEXT,
    audio_filesize   INTEGER,
    audio_duration   INTEGER,
    audio_kind       TEXT,
    transcript_path  TEXT,
    transcript_kind  TEXT,
    sort_reference   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (track_id, language)
  )`)
  await db.execute(`CREATE TABLE track_references (
    track_id  TEXT NOT NULL,
    ref_idx   INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    tokens    TEXT NOT NULL,
    PRIMARY KEY (track_id, ref_idx)
  )`)
  await db.execute(`CREATE TABLE track_tags (
    track_id TEXT,
    tag_id   TEXT,
    PRIMARY KEY (track_id, tag_id)
  )`)
  await db.execute(`CREATE TABLE locations (
    id        TEXT NOT NULL,
    language  TEXT NOT NULL,
    full_name TEXT NOT NULL,
    PRIMARY KEY (id, language)
  )`)
  await db.execute(`CREATE TABLE tags (
    id        TEXT NOT NULL,
    language  TEXT NOT NULL,
    full_name TEXT NOT NULL,
    PRIMARY KEY (id, language)
  )`)
  await db.execute(`CREATE VIRTUAL TABLE tracks_search USING fts4(
    content,
    track_id,
    kind,
    notindexed="track_id",
    notindexed="kind",
    tokenize=unicode61 "remove_diacritics=2"
  )`)
}

interface FixtureSource {
  id: string
  en: { full: string; short: string }
}

interface FixtureLocation {
  id: string
  names: Record<string, string>
}

interface FixtureTag {
  id: string
  names: Record<string, string>
}

interface FixtureRefGroup {
  sourceId: string
  tokens: string
}

interface FixtureTrack {
  id: string
  date: string | null
  titles: Record<string, string>
  references: FixtureRefGroup[]
  locationId?: string | null
  tagIds?: string[]
  sortReference?: string
  hidden?: boolean
}

const sortRefFromGroup = (g: FixtureRefGroup): string => `${g.sourceId}_${g.tokens}`

async function seedFixture(
  db: IDatabase,
  sources: FixtureSource[],
  tracks: FixtureTrack[],
  locations: FixtureLocation[] = [],
  tags: FixtureTag[] = []
): Promise<void> {
  for (const s of sources) {
    await db.execute(
      `INSERT INTO sources (id, language, full_name, short_name) VALUES (?, ?, ?, ?)`,
      [s.id, "en", s.en.full, s.en.short]
    )
  }
  for (const l of locations) {
    for (const [lang, name] of Object.entries(l.names)) {
      await db.execute(`INSERT INTO locations (id, language, full_name) VALUES (?, ?, ?)`, [
        l.id,
        lang,
        name,
      ])
    }
  }
  for (const tg of tags) {
    for (const [lang, name] of Object.entries(tg.names)) {
      await db.execute(`INSERT INTO tags (id, language, full_name) VALUES (?, ?, ?)`, [
        tg.id,
        lang,
        name,
      ])
    }
  }
  for (const t of tracks) {
    const sortRef = t.sortReference ?? (t.references[0] ? sortRefFromGroup(t.references[0]) : "zzz")
    const sortDate = t.date ? t.date.replace(/-/g, "") : "00000000"
    await db.execute(
      `INSERT INTO tracks (id, author_id, location_id, date, hidden, sort_reference, sort_date)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      [t.id, t.locationId ?? null, t.date, t.hidden ? 1 : 0, sortRef, sortDate]
    )
    for (const [lang, title] of Object.entries(t.titles)) {
      await db.execute(
        `INSERT INTO track_variants (track_id, language, title, sort_reference) VALUES (?, ?, ?, ?)`,
        [t.id, lang, title, sortRef]
      )
    }
    for (let idx = 0; idx < t.references.length; idx++) {
      const r = t.references[idx]
      await db.execute(
        `INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES (?, ?, ?, ?)`,
        [t.id, idx, r.sourceId, r.tokens]
      )
    }
    for (const tagId of t.tagIds ?? []) {
      await db.execute(`INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)`, [t.id, tagId])
    }
  }
  // Populate the FTS index exactly the way the catalog writer does
  // (modules/tools/shruti-mcp/internal/infra/catalog/sqlite/write.go
  // rebuildTrackSearchRows). The `combined` kind is what `search()`
  // filters on.
  await db.execute(
    `INSERT INTO tracks_search(content, track_id, kind)
       SELECT title, track_id, 'title' FROM track_variants`
  )
  await db.execute(
    `INSERT INTO tracks_search(content, track_id, kind)
         SELECT r.source_id || ' ' || r.tokens, r.track_id, 'reference'
         FROM track_references r
       UNION ALL
         SELECT s.short_name || ' ' || r.tokens, r.track_id, 'reference'
         FROM track_references r JOIN sources s ON s.id = r.source_id
         WHERE s.short_name <> ''
       UNION ALL
         SELECT s.full_name || ' ' || r.tokens, r.track_id, 'reference'
         FROM track_references r JOIN sources s ON s.id = r.source_id
         WHERE s.full_name <> ''`
  )
  await db.execute(
    `INSERT INTO tracks_search(content, track_id, kind)
     SELECT
       (
         COALESCE((SELECT GROUP_CONCAT(title, ' ') FROM track_variants WHERE track_id = t.id), '')
         || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(r.source_id || ' ' || r.tokens, ' ')
                   FROM track_references r WHERE r.track_id = t.id), '')
         || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(s.short_name || ' ' || r.tokens, ' ')
                   FROM track_references r JOIN sources s ON s.id = r.source_id
                   WHERE r.track_id = t.id AND s.short_name <> ''), '')
         || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(s.full_name || ' ' || r.tokens, ' ')
                   FROM track_references r JOIN sources s ON s.id = r.source_id
                   WHERE r.track_id = t.id AND s.full_name <> ''), '')
         || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(l.full_name, ' ')
                   FROM locations l
                   WHERE l.id = t.location_id), '')
         || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(tg.full_name, ' ')
                   FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id
                   WHERE tt.track_id = t.id AND tg.full_name <> ''), '')
         || ' ' || COALESCE(SUBSTR(t.date, 1, 4), '')
         || ' ' || COALESCE(SUBSTR(t.date, 1, 7), '')
         || ' ' || COALESCE(SUBSTR(t.date, 1, 10), '')
       ),
       t.id,
       'combined'
     FROM tracks t`
  )
}

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const SOURCES: FixtureSource[] = [
  { id: "bg", en: { full: "Bhagavad-gita", short: "BG" } },
  { id: "sb", en: { full: "Srimad Bhagavatam", short: "SB" } },
]

const LOCATIONS: FixtureLocation[] = [
  { id: "loc-bombay", names: { en: "Bombay", ru: "Бомбей" } },
  { id: "loc-london", names: { en: "London", ru: "Лондон" } },
]

const TAGS: FixtureTag[] = [
  { id: "tag_morning_walk", names: { en: "Morning Walk", ru: "Утренняя прогулка" } },
  { id: "tag_conversation", names: { en: "Conversation", ru: "Беседа" } },
]

const TRACKS: FixtureTrack[] = [
  {
    id: "t-bg-1974-2-12",
    date: "1974-10-20",
    titles: { en: "Life After Death" },
    references: [{ sourceId: "bg", tokens: "2.12" }],
    locationId: "loc-bombay",
    tagIds: ["tag_morning_walk"],
  },
  {
    id: "t-bg-1974-2-13",
    date: "1974-11-01",
    titles: { en: "Eternality of the Soul" },
    references: [{ sourceId: "bg", tokens: "2.13" }],
    locationId: "loc-london",
    tagIds: ["tag_conversation"],
  },
  {
    id: "t-bg-1975-2-13",
    date: "1975-05-05",
    titles: { en: "Soul Talk" },
    references: [{ sourceId: "bg", tokens: "2.13" }],
    locationId: "loc-bombay",
  },
  {
    id: "t-sb-1976-1-1",
    date: "1976-03-15",
    titles: { en: "Beginnings" },
    references: [{ sourceId: "sb", tokens: "1.1.1" }],
  },
  {
    id: "t-bg-1977-no-date",
    date: null,
    titles: { en: "Gentleman Talk", ru: "Джентельмен" },
    references: [{ sourceId: "bg", tokens: "9.9" }],
  },
]

/* -------------------------------------------------------------------------- */
/*                                   tests                                    */
/* -------------------------------------------------------------------------- */

describe("tracksRepository.sql — search", () => {
  let db: IDatabase
  const getLang = (): LanguageCode => "en" as LanguageCode

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyContentSchemaForTests(db)
    await seedFixture(db, SOURCES, TRACKS, LOCATIONS, TAGS)
  })

  it("returns every track whose references include token 2.13", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "2.13" })
    const ids = results.map((t) => t.id).sort()
    expect(ids).toEqual(["t-bg-1974-2-13", "t-bg-1975-2-13"])
  })

  it("returns every track with at least one BG reference", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "BG" })
    const ids = results.map((t) => t.id).sort()
    expect(ids).toEqual(["t-bg-1974-2-12", "t-bg-1974-2-13", "t-bg-1975-2-13", "t-bg-1977-no-date"])
  })

  it("returns every track dated in a given year", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "1974" })
    const ids = results.map((t) => t.id).sort()
    expect(ids).toEqual(["t-bg-1974-2-12", "t-bg-1974-2-13"])
  })

  it("ANDs across source / year / reference tokens", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "BG 1974 2.12" })
    const ids = results.map((t) => t.id)
    expect(ids).toEqual(["t-bg-1974-2-12"])
  })

  it("matches by title", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "Life After Death" })
    const ids = results.map((t) => t.id)
    expect(ids).toEqual(["t-bg-1974-2-12"])
  })

  it("matches by location name in active language", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "Bombay" })
    const ids = results.map((t) => t.id).sort()
    expect(ids).toEqual(["t-bg-1974-2-12", "t-bg-1975-2-13"])
  })

  it("matches by location name in any indexed language", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "Лондон" })
    const ids = results.map((t) => t.id)
    expect(ids).toEqual(["t-bg-1974-2-13"])
  })

  it("ANDs location with source and year", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "Bombay BG 1974" })
    const ids = results.map((t) => t.id)
    expect(ids).toEqual(["t-bg-1974-2-12"])
  })

  it("matches by tag name (kind) in either language", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const enResults = await repo.search({ text: "morning walk" })
    expect(enResults.map((t) => t.id)).toEqual(["t-bg-1974-2-12"])
    const ruResults = await repo.search({ text: "беседа" })
    expect(ruResults.map((t) => t.id)).toEqual(["t-bg-1974-2-13"])
  })

  it("matches by year-month and full date", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const ym = await repo.search({ text: "1974-10" })
    expect(ym.map((t) => t.id)).toEqual(["t-bg-1974-2-12"])
    const full = await repo.search({ text: "1974-10-20" })
    expect(full.map((t) => t.id)).toEqual(["t-bg-1974-2-12"])
  })

  it("phrase queries in double quotes require adjacency", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const exact = await repo.search({ text: `"Life After Death"` })
    expect(exact.map((t) => t.id)).toEqual(["t-bg-1974-2-12"])
    // Same tokens but not adjacent — phrase must NOT match anything
    // that lacks the exact "after death" sequence.
    const nonAdjacent = await repo.search({ text: `"Death After Life"` })
    expect(nonAdjacent).toEqual([])
  })

  it("matches Cyrillic single-token prefix (FTS4 quirk preserved)", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "Джент" })
    const ids = results.map((t) => t.id)
    expect(ids).toEqual(["t-bg-1977-no-date"])
  })

  it("returns no results for an empty query", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    expect(await repo.search({ text: "" })).toEqual([])
    expect(await repo.search({ text: "   " })).toEqual([])
  })

  it("does not return duplicate rows when a track has multiple references", async () => {
    // Sanity: the new query path scopes to kind='combined', so each
    // track contributes exactly one search row even if it has many refs.
    await db.execute(
      `INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES (?, ?, ?, ?)`,
      ["t-bg-1974-2-12", 1, "sb", "1.1.2"]
    )
    // Rebuild combined row to reflect the new reference (mirrors a
    // re-import). Drop + re-insert for this track only.
    await db.execute(`DELETE FROM tracks_search WHERE track_id = ? AND kind = 'combined'`, [
      "t-bg-1974-2-12",
    ])
    await db.execute(
      `INSERT INTO tracks_search(content, track_id, kind)
       SELECT
         (
           COALESCE((SELECT GROUP_CONCAT(title, ' ') FROM track_variants WHERE track_id = t.id), '')
           || ' ' ||
           COALESCE((SELECT GROUP_CONCAT(r.source_id || ' ' || r.tokens, ' ')
                     FROM track_references r WHERE r.track_id = t.id), '')
           || ' ' || COALESCE(SUBSTR(t.date, 1, 4), '')
         ),
         t.id,
         'combined'
       FROM tracks t WHERE t.id = ?`,
      ["t-bg-1974-2-12"]
    )
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "BG" })
    const ids = results.map((t) => t.id)
    const unique = Array.from(new Set(ids))
    expect(ids).toEqual(unique)
  })
})
