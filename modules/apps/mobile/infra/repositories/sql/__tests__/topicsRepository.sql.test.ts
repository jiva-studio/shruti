import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import { createSqlTopicRepository } from "../topicsRepository.sql.js"
import { createInMemoryTestDatabase } from "./testDb.js"

// Minimal slice of the catalog wire-schema the topic repo touches.
async function applySchema(db: IDatabase): Promise<void> {
  await db.execute(`CREATE TABLE tracks (id TEXT PRIMARY KEY, hidden INTEGER NOT NULL DEFAULT 0)`)
  await db.execute(`CREATE TABLE track_variants (
    track_id TEXT NOT NULL, language TEXT NOT NULL, PRIMARY KEY (track_id, language))`)
  await db.execute(`CREATE TABLE topics (
    id TEXT NOT NULL, language TEXT NOT NULL,
    full_name TEXT NOT NULL, short_name TEXT, cover TEXT,
    PRIMARY KEY (id, language))`)
  await db.execute(`CREATE TABLE track_topics (
    track_id TEXT NOT NULL, topic_id TEXT NOT NULL, weight REAL NOT NULL,
    PRIMARY KEY (track_id, topic_id))`)
  await db.execute(`CREATE TABLE track_tags (
    track_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (track_id, tag_id))`)
  await db.execute(`CREATE TABLE track_references (
    track_id TEXT NOT NULL, ref_idx INTEGER NOT NULL, source_id TEXT NOT NULL,
    tokens TEXT NOT NULL, PRIMARY KEY (track_id, ref_idx))`)
}

async function seed(db: IDatabase): Promise<void> {
  // tA: en only, tB: ru only, tC: en + ru, tD: ru only.
  for (const id of ["tA", "tB", "tC", "tD"]) {
    await db.execute(`INSERT INTO tracks (id, hidden) VALUES (?, 0)`, [id])
  }
  const variants: [string, string][] = [
    ["tA", "en"],
    ["tB", "ru"],
    ["tC", "en"],
    ["tC", "ru"],
    ["tD", "ru"],
  ]
  for (const [t, l] of variants) {
    await db.execute(`INSERT INTO track_variants (track_id, language) VALUES (?, ?)`, [t, l])
  }
  // Topic T1 over tA/tB/tC; topic T2 over tD only.
  await db.execute(`INSERT INTO topics (id, language, full_name) VALUES ('T1', 'en', 'One')`)
  await db.execute(`INSERT INTO topics (id, language, full_name) VALUES ('T2', 'en', 'Two')`)
  const memberships: [string, string, number][] = [
    ["tA", "T1", 0.5],
    ["tB", "T1", 0.4],
    ["tC", "T1", 0.3],
    ["tD", "T2", 0.9],
  ]
  for (const [t, topic, w] of memberships) {
    await db.execute(`INSERT INTO track_topics (track_id, topic_id, weight) VALUES (?, ?, ?)`, [
      t,
      topic,
      w,
    ])
  }
  // tA is a kind-tagged track (e.g. a morning walk); tB/tC are untagged
  // lectures. The onboarding pick (`lecturesOnly`) must drop tA.
  await db.execute(`INSERT INTO track_tags (track_id, tag_id) VALUES ('tA', 'tag_morning_walk')`)
  // tB and tA are tied to a scripture verse; tC is not. `withReference` keeps
  // only tB/tA; combined with `lecturesOnly` (drops tA) only tB survives.
  await db.execute(
    `INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES
       ('tA', 0, 'src1', '1.1'), ('tB', 0, 'src1', '2.2')`
  )
}

const en: LanguageCode[] = ["en"]
const ru: LanguageCode[] = ["ru"]
const both: LanguageCode[] = ["en", "ru"]

describe("topicsRepository — library-language filtering", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlTopicRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await seed(db)
    repo = createSqlTopicRepository(db)
  })

  it("topTrackIds returns only tracks with a variant in the languages, weight-ordered", async () => {
    expect(await repo.topTrackIds("T1" as TopicId, en, 10)).toEqual(["tA", "tC"])
    expect(await repo.topTrackIds("T1" as TopicId, ru, 10)).toEqual(["tB", "tC"])
  })

  it("topTrackIds with no languages returns every track on the topic", async () => {
    expect(await repo.topTrackIds("T1" as TopicId, [], 10)).toEqual(["tA", "tB", "tC"])
  })

  it("topTrackIds lecturesOnly drops kind-tagged tracks", async () => {
    // tA is tagged (morning walk) → excluded; tB/tC are untagged lectures.
    expect(await repo.topTrackIds("T1" as TopicId, [], 10, { lecturesOnly: true })).toEqual([
      "tB",
      "tC",
    ])
    expect(await repo.topTrackIds("T1" as TopicId, both, 10, { lecturesOnly: true })).toEqual([
      "tB",
      "tC",
    ])
  })

  it("topTrackIds withReference keeps only verse-tied tracks", async () => {
    // tA + tB have a scripture reference, tC does not.
    expect(await repo.topTrackIds("T1" as TopicId, [], 10, { withReference: true })).toEqual([
      "tA",
      "tB",
    ])
    // Combined with lecturesOnly: tA is dropped (tagged) → only tB survives.
    expect(
      await repo.topTrackIds("T1" as TopicId, [], 10, { lecturesOnly: true, withReference: true })
    ).toEqual(["tB"])
  })

  it("topTrackIds does not duplicate a track that has several matching variants", async () => {
    // tC has both en and ru; filtering on both must still yield it once.
    expect(await repo.topTrackIds("T1" as TopicId, both, 10)).toEqual(["tA", "tB", "tC"])
  })

  it("topicIdsWithTracksIn drops topics with no lectures in the languages", async () => {
    expect([...(await repo.topicIdsWithTracksIn(en))].sort()).toEqual(["T1"])
    expect([...(await repo.topicIdsWithTracksIn(ru))].sort()).toEqual(["T1", "T2"])
    expect([...(await repo.topicIdsWithTracksIn([]))].sort()).toEqual(["T1", "T2"])
  })

  it("getByIds preserves caller order and drops unknown ids", async () => {
    const got = await repo.getByIds(["T2", "T1", "nope"] as TopicId[])
    expect(got.map((t) => t.id)).toEqual(["T2", "T1"])
    expect(await repo.getByIds([])).toEqual([])
  })

  it("similarTrackIds filters neighbours by language and never inflates the score", async () => {
    // Seed topic T1, exclude tA. en-only → tC (tB is ru-only).
    expect(await repo.similarTrackIds(["T1"] as TopicId[], "tA" as TrackId, en, 10)).toEqual(["tC"])
    // Both languages → tB (0.4) then tC (0.3). A JOIN would double tC to 0.6 and
    // wrongly rank it first; EXISTS keeps the order honest.
    expect(await repo.similarTrackIds(["T1"] as TopicId[], "tA" as TrackId, both, 10)).toEqual([
      "tB",
      "tC",
    ])
  })
})

describe("topicsRepository — similarity is cosine, not raw overlap", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlTopicRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    for (const id of ["seed", "narrow", "broad"]) {
      await db.execute(`INSERT INTO tracks (id, hidden) VALUES (?, 0)`, [id])
      await db.execute(`INSERT INTO track_variants (track_id, language) VALUES (?, 'en')`, [id])
    }
    const rows: [string, string, number][] = [
      ["seed", "T1", 0.5],
      ["seed", "T2", 0.5],
      ["narrow", "T1", 1.0], // one topic, all of its weight
      ["broad", "T1", 0.3], // shares both seed topics, plus ground of its own
      ["broad", "T2", 0.3],
      ["broad", "T3", 0.4],
    ]
    for (const [t, topic, w] of rows) {
      await db.execute(`INSERT INTO track_topics (track_id, topic_id, weight) VALUES (?, ?, ?)`, [
        t,
        topic,
        w,
      ])
    }
    repo = createSqlTopicRepository(db)
  })

  it("ranks a track sharing both seed topics above one that is all of a single topic", async () => {
    // SUM(weight) would score narrow 1.0 against broad 0.6 and invert this.
    expect(
      await repo.similarTrackIds(["T1", "T2"] as TopicId[], "seed" as TrackId, [], 10)
    ).toEqual(["broad", "narrow"])
  })

  it("still prefers a narrow track when it is squarely on the one seed topic", async () => {
    // The correction must not simply punish short tracks: with T1 alone as the
    // seed, the track that is entirely about T1 is the better neighbour.
    expect(await repo.similarTrackIds(["T1"] as TopicId[], "seed" as TrackId, [], 10)).toEqual([
      "narrow",
      "broad",
    ])
  })
})

/**
 * Issue #1741 (7): the topic queries never joined `tracks`, so a hidden track
 * came back among the ids. `tracks.getByIds` — which every caller feeds them
 * into — filters `hidden = 0`, so the page rendered fewer rows than it asked
 * for and "Add all" queued fewer lectures than it implied.
 */
describe("topicsRepository — hidden tracks", () => {
  let db: IDatabase
  let repo: ReturnType<typeof createSqlTopicRepository>

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applySchema(db)
    await seed(db)
    // tH is on T1 with the highest weight — and hidden. tZ is the only track
    // of topic T3, also hidden, so T3 opens onto nothing.
    for (const id of ["tH", "tZ"]) {
      await db.execute(`INSERT INTO tracks (id, hidden) VALUES (?, 1)`, [id])
      await db.execute(`INSERT INTO track_variants (track_id, language) VALUES (?, 'en')`, [id])
    }
    await db.execute(`INSERT INTO track_topics (track_id, topic_id, weight) VALUES ('tH','T1',0.9)`)
    await db.execute(`INSERT INTO track_topics (track_id, topic_id, weight) VALUES ('tZ','T3',0.9)`)
    repo = createSqlTopicRepository(db)
  })

  it("topTrackIds leaves them out, with and without a language filter", async () => {
    expect(await repo.topTrackIds("T1" as TopicId, [], 10)).toEqual(["tA", "tB", "tC"])
    expect(await repo.topTrackIds("T1" as TopicId, en, 10)).toEqual(["tA", "tC"])
  })

  it("topTrackIds still fills the page it was asked for", async () => {
    // Two visible tracks are wanted; handing back tH as one of them left the
    // caller with one row after `getByIds` dropped it.
    expect(await repo.topTrackIds("T1" as TopicId, [], 2)).toEqual(["tA", "tB"])
  })

  it("topicIdsWithTracksIn drops a topic whose only tracks are hidden", async () => {
    expect([...(await repo.topicIdsWithTracksIn(en))].sort()).toEqual(["T1"])
    expect([...(await repo.topicIdsWithTracksIn([]))].sort()).toEqual(["T1", "T2"])
  })

  it("similarTrackIds does not recommend them", async () => {
    expect(await repo.similarTrackIds(["T1"] as TopicId[], "tA" as TrackId, [], 10)).toEqual([
      "tB",
      "tC",
    ])
  })
})
