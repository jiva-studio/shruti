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

  it("topTrackIds does not duplicate a track that has several matching variants", async () => {
    // tC has both en and ru; filtering on both must still yield it once.
    expect(await repo.topTrackIds("T1" as TopicId, both, 10)).toEqual(["tA", "tB", "tC"])
  })

  it("topicIdsWithTracksIn drops topics with no lectures in the languages", async () => {
    expect([...(await repo.topicIdsWithTracksIn(en))].sort()).toEqual(["T1"])
    expect([...(await repo.topicIdsWithTracksIn(ru))].sort()).toEqual(["T1", "T2"])
    expect([...(await repo.topicIdsWithTracksIn([]))].sort()).toEqual(["T1", "T2"])
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
