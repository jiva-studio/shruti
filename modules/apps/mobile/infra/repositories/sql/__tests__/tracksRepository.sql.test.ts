import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode } from "@lib/domain/core.js"
import {
  buildFtsQuery,
  createSqlTrackRepository,
  normalizeBlob,
  scoreMatchinfo,
} from "../tracksRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

/**
 * Minimal content-DB schema for the search tests.
 *
 * Mirrors the catalog wire-schema owned by `modules/tools/lectorium-mcp`
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
    hidden          INTEGER NOT NULL DEFAULT 0
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
    sort_reference   TEXT,
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
  /**
   * Per-locale override of the sort_reference written to track_variants.
   * Map locale → sort key. When omitted, every variant inherits the
   * default `${sourceId}_${tokens}` shape from the first reference (or
   * NULL when the track has no references).
   */
  sortReference?: Record<string, string | null>
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
    const defaultSortRef: string | null = t.references[0] ? sortRefFromGroup(t.references[0]) : null
    await db.execute(
      `INSERT INTO tracks (id, author_id, location_id, date, hidden)
       VALUES (?, NULL, ?, ?, ?)`,
      [t.id, t.locationId ?? null, t.date, t.hidden ? 1 : 0]
    )
    for (const [lang, title] of Object.entries(t.titles)) {
      const sortRef =
        t.sortReference && lang in t.sortReference ? t.sortReference[lang] : defaultSortRef
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
  // (modules/tools/lectorium-mcp/internal/infra/catalog/sqlite/write.go
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

/**
 * Wipe every table the fixture seeds, so a test can re-seed an
 * alternative corpus. Run each DELETE separately — `db.run` in sql.js
 * only consumes the first statement.
 */
async function clearAllFixtureTables(db: IDatabase): Promise<void> {
  await db.execute(`DELETE FROM tracks_search`)
  await db.execute(`DELETE FROM track_tags`)
  await db.execute(`DELETE FROM track_references`)
  await db.execute(`DELETE FROM track_variants`)
  await db.execute(`DELETE FROM tracks`)
  await db.execute(`DELETE FROM tags`)
  await db.execute(`DELETE FROM locations`)
  await db.execute(`DELETE FROM sources`)
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

  it("ranks exact reference matches above prefix-only matches", async () => {
    // Reproduces the bug behind #407: searching for "bg 2.13" used to
    // surface BG 13.21, BG 4.24, BG 9.13 ahead of BG 2.13 because
    // FTS tokenised the query as `2* 13*` and the sort key ignored
    // match quality. With phrase-promotion + matchinfo-based ranking,
    // BG 2.13 must come first.
    await clearAllFixtureTables(db)
    await seedFixture(
      db,
      [{ id: "bg", en: { full: "Bhagavad-gita", short: "BG" } }],
      [
        {
          id: "t-bg-2-13",
          date: "1974-11-01",
          titles: { en: "BG 2.13" },
          references: [{ sourceId: "bg", tokens: "2.13" }],
        },
        {
          id: "t-bg-13-21",
          date: "1974-10-20",
          titles: { en: "BG 13.21" },
          references: [{ sourceId: "bg", tokens: "13.21" }],
        },
        {
          id: "t-bg-4-24",
          date: "1974-04-13",
          titles: { en: "BG 4.24" },
          references: [{ sourceId: "bg", tokens: "4.24" }],
        },
        {
          id: "t-bg-13-1",
          date: "1975-06-01",
          titles: { en: "BG 13.1" },
          references: [{ sourceId: "bg", tokens: "13.1" }],
        },
      ]
    )
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "bg 2.13" })
    const ids = results.map((t) => t.id)
    expect(ids[0]).toBe("t-bg-2-13")
  })

  it("ranks BG 13.1 above BG 13.21 / BG 13.20 for query `bg 13.1`", async () => {
    await clearAllFixtureTables(db)
    await seedFixture(
      db,
      [{ id: "bg", en: { full: "Bhagavad-gita", short: "BG" } }],
      [
        {
          id: "t-bg-13-1",
          date: "1974-05-05",
          titles: { en: "BG 13.1" },
          references: [{ sourceId: "bg", tokens: "13.1" }],
        },
        {
          id: "t-bg-13-1-2",
          date: "1974-06-06",
          titles: { en: "BG 13.1-2" },
          references: [{ sourceId: "bg", tokens: "13.1-2" }],
        },
        {
          id: "t-bg-13-21",
          date: "1975-01-01",
          titles: { en: "BG 13.21" },
          references: [{ sourceId: "bg", tokens: "13.21" }],
        },
        {
          id: "t-bg-13-20",
          date: "1975-02-02",
          titles: { en: "BG 13.20" },
          references: [{ sourceId: "bg", tokens: "13.20" }],
        },
      ]
    )
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({ text: "bg 13.1" })
    const ids = results.map((t) => t.id)
    // BG 13.1 (and BG 13.1-2 — the `13.1-2` reference contains the
    // adjacent `13 1` token pair) must come ahead of BG 13.21 / 13.20.
    const idx131 = ids.indexOf("t-bg-13-1")
    const idx1321 = ids.indexOf("t-bg-13-21")
    const idx1320 = ids.indexOf("t-bg-13-20")
    expect(idx131).toBeGreaterThanOrEqual(0)
    if (idx1321 !== -1) expect(idx131).toBeLessThan(idx1321)
    if (idx1320 !== -1) expect(idx131).toBeLessThan(idx1320)
    const idx1312 = ids.indexOf("t-bg-13-1-2")
    if (idx1312 !== -1 && idx1321 !== -1) expect(idx1312).toBeLessThan(idx1321)
    if (idx1312 !== -1 && idx1320 !== -1) expect(idx1312).toBeLessThan(idx1320)
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

describe("tracksRepository.sql — buildFtsQuery", () => {
  it("promotes a multi-component reference to a phrase, leaves the word prefix", () => {
    expect(buildFtsQuery("bg 2.13")).toBe(`bg* "2 13"`)
  })

  it("handles a bare multi-component reference", () => {
    expect(buildFtsQuery("1.1.2")).toBe(`"1 1 2"`)
  })

  it("leaves a bare year as a prefix, not a phrase", () => {
    expect(buildFtsQuery("1974")).toBe("1974*")
  })

  it("mixes prefix, phrase, and bare year", () => {
    expect(buildFtsQuery("BG 1974 2.13")).toBe(`bg* 1974* "2 13"`)
  })

  it("handles a Cyrillic reference query (Russian source prefix + dotted ref)", () => {
    expect(buildFtsQuery("шб 1.1.2 1974")).toBe(`шб* "1 1 2" 1974*`)
  })

  it("preserves the existing single-token Cyrillic prefix quirk", () => {
    // Quoted single Cyrillic token stays bare prefix — see the FTS4
    // quirk note in buildFtsQuery.
    expect(buildFtsQuery(`"Джент"`)).toBe(`джент*`)
  })

  it("preserves quoted phrase semantics without double-quoting", () => {
    expect(buildFtsQuery(`"life after death"`)).toBe(`"life after death"`)
  })

  it("returns an empty string for whitespace-only input", () => {
    expect(buildFtsQuery("   ")).toBe("")
    expect(buildFtsQuery("")).toBe("")
  })
})

describe("tracksRepository.sql — scoreMatchinfo blob normalisation", () => {
  // FTS4 matchinfo('pcx') with p=1, c=1, hits_in_row=2, hits_in_corpus=2,
  // rows_with_term=1 → ten u32 LE bytes for the header + triple.
  const pcxBytes = new Uint8Array(new Uint32Array([1, 1, 2, 2, 1]).buffer)

  it("scores a Uint8Array blob (sql.js path)", () => {
    const score = scoreMatchinfo(pcxBytes, 10)
    expect(score).toBeGreaterThan(0)
  })

  it("scores a number[] blob — the shape @capacitor-community/sqlite returns on Android/iOS", () => {
    // Repros the search-page DataView crash: native plugin JSON-serialises
    // BLOBs as plain number arrays, but scoreMatchinfo used to do
    // `new DataView(blob.buffer)` and throw because `number[].buffer` is undefined.
    const asNumberArray = Array.from(pcxBytes)
    expect(() => scoreMatchinfo(asNumberArray, 10)).not.toThrow()
    expect(scoreMatchinfo(asNumberArray, 10)).toBe(scoreMatchinfo(pcxBytes, 10))
  })

  it("scores a base64 string blob (alternate Capacitor path)", () => {
    const base64 = btoa(String.fromCharCode(...pcxBytes))
    expect(scoreMatchinfo(base64, 10)).toBe(scoreMatchinfo(pcxBytes, 10))
  })

  it("returns 0 for null / undefined / malformed input", () => {
    expect(scoreMatchinfo(null, 10)).toBe(0)
    expect(scoreMatchinfo(undefined, 10)).toBe(0)
    expect(scoreMatchinfo(new Uint8Array(4), 10)).toBe(0) // < 8 bytes
    expect(normalizeBlob("***not-base64***")).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*                                   sort                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sort tests use a separate fixture set so locale-aware reference keys
 * (Cyrillic prefix for ru, Latin for en) can be expressed explicitly. The
 * key promise tested here is "tracks without a date / reference always
 * land at the end, regardless of direction or UI language".
 */
const SORT_SOURCES: FixtureSource[] = [
  { id: "src_bg", en: { full: "Bhagavad-gita", short: "BG" } },
  { id: "src_sb", en: { full: "Srimad Bhagavatam", short: "SB" } },
]

const SORT_TRACKS: FixtureTrack[] = [
  {
    id: "bg-6-32",
    date: "1966-09-14",
    titles: { en: "BG 6.32", ru: "БГ 6.32" },
    references: [{ sourceId: "src_bg", tokens: "6.32" }],
    sortReference: {
      en: "BG_000006_000032",
      ru: "БГ_000006_000032",
    },
  },
  {
    id: "sb-2-1-7",
    date: "1974-06-15",
    titles: { en: "SB 2.1.7", ru: "ШБ 2.1.7" },
    references: [{ sourceId: "src_sb", tokens: "2.1.7" }],
    sortReference: {
      en: "SB_000002_000001_000007",
      ru: "ШБ_000002_000001_000007",
    },
  },
  {
    id: "sb-6-1-63",
    date: "1975-08-31",
    titles: { en: "SB 6.1.63", ru: "ШБ 6.1.63" },
    references: [{ sourceId: "src_sb", tokens: "6.1.63" }],
    sortReference: {
      en: "SB_000006_000001_000063",
      ru: "ШБ_000006_000001_000063",
    },
  },
  {
    id: "morning-walk-1976",
    date: "1976-02-21",
    titles: { en: "Morning Walk 1976", ru: "Утренняя прогулка 1976" },
    references: [],
    sortReference: { en: null, ru: null },
  },
  {
    id: "morning-walk-1973",
    date: "1973-05-15",
    titles: { en: "Morning Walk 1973", ru: "Утренняя прогулка 1973" },
    references: [],
    sortReference: { en: null, ru: null },
  },
  {
    id: "no-date",
    date: null,
    titles: { en: "Undated lecture", ru: "Лекция без даты" },
    references: [{ sourceId: "src_bg", tokens: "1.1" }],
    sortReference: {
      en: "BG_000001_000001",
      ru: "БГ_000001_000001",
    },
  },
]

describe("tracksRepository.sql — list sort order", () => {
  let db: IDatabase
  let language: LanguageCode

  const lang = (): LanguageCode => language

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyContentSchemaForTests(db)
    await seedFixture(db, SORT_SOURCES, SORT_TRACKS)
    language = "en" as LanguageCode
  })

  it("byReference in EN locale: no-shloka tracks last, sorted by date DESC within tail", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: lang })
    const results = await repo.list({ sortBy: "byReference" })
    expect(results.map((t) => t.id)).toEqual([
      "no-date", // BG_000001_000001
      "bg-6-32", // BG_000006_000032
      "sb-2-1-7", // SB_000002_000001_000007
      "sb-6-1-63", // SB_000006_000001_000063
      // Morning Walks (no shloka) — NULL last, ordered by date DESC inside the tail.
      "morning-walk-1976",
      "morning-walk-1973",
    ])
  })

  it("byReference in RU locale: Cyrillic prefixes order correctly, no-shloka still last", async () => {
    language = "ru" as LanguageCode
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: lang })
    const results = await repo.list({ sortBy: "byReference" })
    // Cyrillic alphabet: Б < Ш. NULL pushed last by NULLS LAST regardless
    // of the byte-order of any sentinel (this is exactly the bug fix).
    expect(results.map((t) => t.id)).toEqual([
      "no-date", // БГ_000001_000001
      "bg-6-32", // БГ_000006_000032
      "sb-2-1-7", // ШБ_000002_000001_000007
      "sb-6-1-63", // ШБ_000006_000001_000063
      "morning-walk-1976",
      "morning-walk-1973",
    ])
  })

  it("byDateDesc: newest first, tracks without date at the very end", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: lang })
    const results = await repo.list({ sortBy: "byDateDesc" })
    expect(results.map((t) => t.id)).toEqual([
      "morning-walk-1976", // 1976-02-21
      "sb-6-1-63", // 1975-08-31
      "sb-2-1-7", // 1974-06-15
      "morning-walk-1973", // 1973-05-15
      "bg-6-32", // 1966-09-14
      "no-date", // NULL → tail
    ])
  })

  it("byDateAsc: oldest first, tracks without date STILL at the very end", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: lang })
    const results = await repo.list({ sortBy: "byDateAsc" })
    expect(results.map((t) => t.id)).toEqual([
      "bg-6-32", // 1966-09-14
      "morning-walk-1973", // 1973-05-15
      "sb-2-1-7", // 1974-06-15
      "sb-6-1-63", // 1975-08-31
      "morning-walk-1976", // 1976-02-21
      "no-date", // NULL → tail (bug-fix expectation: not at top)
    ])
  })

  it("byReference tiebreaker: identical sort_reference resolves by date DESC", async () => {
    // Two tracks sharing the same sort_reference but different dates —
    // the more recent one wins the tiebreak.
    await db.execute(`DELETE FROM track_variants WHERE track_id = 'morning-walk-1976'`)
    await db.execute(`DELETE FROM tracks WHERE id = 'morning-walk-1976'`)
    await seedFixture(
      db,
      [],
      [
        {
          id: "bg-6-32-older",
          date: "1960-01-01",
          titles: { en: "Older" },
          references: [{ sourceId: "src_bg", tokens: "6.32" }],
          sortReference: { en: "BG_000006_000032" },
        },
      ]
    )
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: lang })
    const results = await repo.list({ sortBy: "byReference" })
    const bg = results.filter((t) => t.id.startsWith("bg-6-32"))
    expect(bg.map((t) => t.id)).toEqual(["bg-6-32", "bg-6-32-older"])
  })
})

/* -------------------------------------------------------------------------- */
/*                              date-range filter                             */
/* -------------------------------------------------------------------------- */

describe("tracksRepository.sql — date range filter", () => {
  let db: IDatabase
  const getLang = (): LanguageCode => "en" as LanguageCode

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyContentSchemaForTests(db)
    await seedFixture(db, SOURCES, TRACKS, LOCATIONS, TAGS)
  })

  it("narrows list() to a single year via gte/lt bounds", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.list({
      filters: { dateGte: "1974-01-01", dateLt: "1975-01-01" },
      sortBy: "byDateAsc",
    })
    expect(results.map((t) => t.id)).toEqual(["t-bg-1974-2-12", "t-bg-1974-2-13"])
  })

  it("treats the upper bound as exclusive and excludes undated tracks", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.list({ filters: { dateGte: "1975-01-01" }, sortBy: "byDateAsc" })
    // 1975 + 1976 tracks; the null-dated track is dropped by `t.date >= ?`.
    expect(results.map((t) => t.id)).toEqual(["t-bg-1975-2-13", "t-sb-1976-1-1"])
  })

  it("supports month-granularity bounds spanning a year boundary", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.list({
      filters: { dateGte: "1974-11-01", dateLt: "1975-06-01" },
      sortBy: "byDateAsc",
    })
    expect(results.map((t) => t.id)).toEqual(["t-bg-1974-2-13", "t-bg-1975-2-13"])
  })

  it("applies the date bounds on the search() path too", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    const results = await repo.search({
      text: "BG",
      filters: { dateGte: "1974-01-01", dateLt: "1975-01-01" },
    })
    expect(results.map((t) => t.id).sort()).toEqual(["t-bg-1974-2-12", "t-bg-1974-2-13"])
  })
})

describe("tracksRepository.sql — listYears", () => {
  let db: IDatabase
  const getLang = (): LanguageCode => "en" as LanguageCode

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyContentSchemaForTests(db)
    await seedFixture(db, SOURCES, TRACKS, LOCATIONS, TAGS)
  })

  it("returns distinct catalog years newest-first, skipping undated tracks", async () => {
    const repo = createSqlTrackRepository({ contentDb: db, getActiveLanguage: getLang })
    expect(await repo.listYears()).toEqual([1976, 1975, 1974])
  })
})
