import { beforeEach, describe, expect, it } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { createSqlListeningSessionRepository } from "../listeningSessionsRepository.sql.js"
import { applyUserSchemaForTests, createInMemoryTestDatabase } from "./testDb.js"

const ITEM_A = "pi-a" as PlaylistItemId
const ITEM_B = "pi-b" as PlaylistItemId

async function rawInsert(
  db: IDatabase,
  args: {
    id: string
    itemId: string
    startedAt: number
    endedAt: number
    fromPosition: number
    toPosition: number
  }
): Promise<void> {
  await db.execute(
    `INSERT INTO listening_sessions
       (id, item_id, started_at, ended_at, from_position, to_position)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [args.id, args.itemId, args.startedAt, args.endedAt, args.fromPosition, args.toPosition]
  )
}

describe("listeningSessionsRepository.sql", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
  })

  it("start() records from_position = position when there is no prior session", async () => {
    const repo = createSqlListeningSessionRepository(db)
    const id = await repo.start({ itemId: ITEM_A, position: 0 })
    const session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.id).toBe(id)
    expect(session?.fromPosition).toBe(0)
    expect(session?.toPosition).toBe(0)
  })

  it("start() inherits from_position from the previous session's to_position", async () => {
    await rawInsert(db, {
      id: "ls1",
      itemId: ITEM_A,
      startedAt: 1000,
      endedAt: 1300,
      fromPosition: 0,
      toPosition: 300,
    })
    const repo = createSqlListeningSessionRepository(db)
    await repo.start({ itemId: ITEM_A, position: 5400 })
    const sessions = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions ORDER BY ended_at"
    )
    expect(sessions).toHaveLength(2)
    expect(sessions[1].from_position).toBe(300)
    expect(sessions[1].to_position).toBe(5400)
  })

  it("start() clamps from_position to position when (re)starting before the prior end", async () => {
    // Prior session finished the lecture at 1467s; the user replays it and
    // resume resets to 0. from_position must clamp to the new position, not
    // inherit 1467 — otherwise to - from is negative and cancels the day.
    await rawInsert(db, {
      id: "ls1",
      itemId: ITEM_A,
      startedAt: 1000,
      endedAt: 1300,
      fromPosition: 0,
      toPosition: 1467,
    })
    const repo = createSqlListeningSessionRepository(db)
    await repo.start({ itemId: ITEM_A, position: 1 })
    const sessions = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions ORDER BY ended_at"
    )
    expect(sessions[1].from_position).toBe(1)
    expect(sessions[1].to_position).toBe(1)
    expect(sessions[1].to_position - sessions[1].from_position).toBeGreaterThanOrEqual(0)
  })

  it("forceStart() ignores prior session and uses the given position", async () => {
    await rawInsert(db, {
      id: "ls1",
      itemId: ITEM_A,
      startedAt: 1000,
      endedAt: 1300,
      fromPosition: 0,
      toPosition: 300,
    })
    const repo = createSqlListeningSessionRepository(db)
    await repo.forceStart({ itemId: ITEM_A, position: 600 })
    const sessions = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions ORDER BY ended_at"
    )
    expect(sessions[1].from_position).toBe(600)
    expect(sessions[1].to_position).toBe(600)
  })

  it("tick() and finish() advance to_position and ended_at", async () => {
    const repo = createSqlListeningSessionRepository(db)
    const id = await repo.start({ itemId: ITEM_A, position: 0 })
    await repo.tick(id, { position: 30 })
    let session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(30)

    await repo.finish(id, { position: 90 })
    session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(90)
  })

  it("getProgressForItems returns latest to_position per item", async () => {
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 100,
    })
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 300,
      endedAt: 400,
      fromPosition: 100,
      toPosition: 250,
    })
    await rawInsert(db, {
      id: "b1",
      itemId: ITEM_B,
      startedAt: 50,
      endedAt: 60,
      fromPosition: 0,
      toPosition: 5,
    })

    const repo = createSqlListeningSessionRepository(db)
    const progress = await repo.getProgressForItems([ITEM_A, ITEM_B])
    expect(progress.get(ITEM_A)?.position).toBe(250)
    expect(progress.get(ITEM_B)?.position).toBe(5)
  })

  it("getCompletedAtForItems returns latest ended_at where to_position >= duration - 2", async () => {
    // Two sessions for item A; first one finished the track (>= dur-2),
    // the user later replays and finishes it again. Anchor must be the
    // latest completion so the auto-archive timer resets on re-listen.
    // duration = 1000, threshold = 998.
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 999,
    })
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 300,
      endedAt: 400,
      fromPosition: 0,
      toPosition: 1000,
    })

    const repo = createSqlListeningSessionRepository(db)
    const result = await repo.getCompletedAtForItems(
      [ITEM_A, ITEM_B],
      new Map([
        [ITEM_A, 1000],
        [ITEM_B, 600],
      ])
    )
    expect(result.get(ITEM_A)).toBe(400)
    expect(result.get(ITEM_B)).toBeNull()
  })

  it("clearAll deletes every row", async () => {
    // Two sessions across two items — both must vanish so that
    // wipeLocalUserData leaves no trace in the activity heatmap or
    // resume-position lookups.
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 100,
    })
    await rawInsert(db, {
      id: "b1",
      itemId: ITEM_B,
      startedAt: 150,
      endedAt: 250,
      fromPosition: 0,
      toPosition: 50,
    })

    const repo = createSqlListeningSessionRepository(db)
    await repo.clearAll()

    const rows = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM listening_sessions")
    expect(rows[0].c).toBe(0)
    expect(await repo.getLastSessionForItem(ITEM_A)).toBeNull()
    expect(await repo.getTotalListenedSeconds()).toBe(0)
  })

  it("getDailyTotals sums to_position - from_position grouped by local-date", async () => {
    // Two sessions on 2026-04-15 (uses now-ish unix seconds).
    const day1 = Math.floor(new Date("2026-04-15T10:00:00Z").getTime() / 1000)
    const day1late = Math.floor(new Date("2026-04-15T20:00:00Z").getTime() / 1000)
    const day2 = Math.floor(new Date("2026-04-16T10:00:00Z").getTime() / 1000)

    await rawInsert(db, {
      id: "s1",
      itemId: ITEM_A,
      startedAt: day1,
      endedAt: day1,
      fromPosition: 0,
      toPosition: 600,
    })
    await rawInsert(db, {
      id: "s2",
      itemId: ITEM_A,
      startedAt: day1late,
      endedAt: day1late,
      fromPosition: 600,
      toPosition: 1500,
    })
    await rawInsert(db, {
      id: "s3",
      itemId: ITEM_B,
      startedAt: day2,
      endedAt: day2,
      fromPosition: 0,
      toPosition: 400,
    })

    const repo = createSqlListeningSessionRepository(db)
    const fromMs = new Date("2026-04-14T00:00:00Z").getTime()
    const toMs = new Date("2026-04-17T00:00:00Z").getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    // localtime might shift a same-UTC-day session into the previous
    // local day for negative-offset zones. We assert SUM is correct
    // regardless of how it splits across two adjacent dates.
    const sum = totals.reduce((acc, t) => acc + t.listenedSeconds, 0)
    expect(sum).toBe(600 + 900 + 400)
  })

  it("getDailyTotalsByDayOffset buckets by whole-day offset from fromMs (timezone-independent)", async () => {
    // Window anchored at an arbitrary local midnight; the offset buckets
    // must NOT depend on SQLite's `localtime`, so a session late in the
    // local day still lands on the same offset the client steps to.
    const fromMs = new Date("2026-04-13T00:00:00Z").getTime()
    const toMs = fromMs + 7 * 86_400_000
    const day = (i: number, hourUtc: number): number =>
      Math.floor((fromMs + i * 86_400_000) / 1000) + hourUtc * 3600

    await rawInsert(db, {
      id: "d0",
      itemId: ITEM_A,
      startedAt: day(0, 9),
      endedAt: day(0, 9),
      fromPosition: 0,
      toPosition: 600,
    })
    // A session late on day 2 — the kind `localtime` could have shifted to
    // the wrong calendar date; here it stays on offset 2 by construction.
    await rawInsert(db, {
      id: "d2",
      itemId: ITEM_B,
      startedAt: day(2, 23),
      endedAt: day(2, 23),
      fromPosition: 100,
      toPosition: 400,
    })

    const repo = createSqlListeningSessionRepository(db)
    const totals = await repo.getDailyTotalsByDayOffset(fromMs, toMs)
    const byOffset = new Map(totals.map((t) => [t.dayOffset, t.listenedSeconds]))
    expect(byOffset.get(0)).toBe(600)
    expect(byOffset.get(2)).toBe(300)
    // No listening on the other five days → no rows for them.
    expect(byOffset.has(1)).toBe(false)
    expect(byOffset.has(3)).toBe(false)
  })

  it("aggregates clamp legacy negative-delta rows to zero", async () => {
    // A legacy row written before the start() clamp (to < from). It must
    // not subtract from the day's heatmap total or the lifetime total.
    const t = Math.floor(new Date("2026-04-15T10:00:00Z").getTime() / 1000)
    await rawInsert(db, {
      id: "good",
      itemId: ITEM_A,
      startedAt: t,
      endedAt: t,
      fromPosition: 0,
      toPosition: 600,
    })
    await rawInsert(db, {
      id: "bad",
      itemId: ITEM_A,
      startedAt: t,
      endedAt: t,
      fromPosition: 1467,
      toPosition: 1,
    })

    const repo = createSqlListeningSessionRepository(db)
    // Lifetime total: 600 (good) + 0 (bad clamped), not 600 + (-1466).
    expect(await repo.getTotalListenedSeconds()).toBe(600)

    const fromMs = new Date("2026-04-14T00:00:00Z").getTime()
    const toMs = new Date("2026-04-17T00:00:00Z").getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    const sum = totals.reduce((acc, x) => acc + x.listenedSeconds, 0)
    expect(sum).toBe(600)
  })
})
