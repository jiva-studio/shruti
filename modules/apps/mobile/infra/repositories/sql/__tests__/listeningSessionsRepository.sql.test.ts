import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IDatabase, QueryParams } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import { COMPLETION_THRESHOLD_SEC } from "@lib/domain/listeningSession.js"
import {
  startOfNextLocalDay,
  useListeningSessionTracker,
} from "@shruti/composables/useListeningSessionTracker.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { createSqlListeningSessionRepository } from "../listeningSessionsRepository.sql.js"
import { createReentrantUnitOfWork } from "../reentrantUnitOfWork.sql.js"
import { createSqlUnitOfWork } from "../unitOfWork.sql.js"
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
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    await repo.start({ itemId: ITEM_A, position: 5400 })
    const sessions = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions ORDER BY ended_at"
    )
    expect(sessions).toHaveLength(2)
    expect(sessions[1].from_position).toBe(300)
    expect(sessions[1].to_position).toBe(5400)
  })

  it("getTotalListenedSeconds collapses a storm cluster instead of double-counting", async () => {
    // One real session (1000s of content) …
    await rawInsert(db, {
      id: "real",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 1100,
      fromPosition: 0,
      toPosition: 1000,
    })
    // … then a pre-#1214 storm: many zero-duration rows flushed at one instant,
    // all sharing (item, started_at, ended_at, from_position), differing only in
    // to_position. Raw SUM would add 10+20+30+40+50 = 150s of phantom; the dedup
    // keeps MAX(to)=1050 → a single 50s span.
    for (const [i, to] of [1010, 1020, 1030, 1040, 1050].entries()) {
      await rawInsert(db, {
        id: `storm-${i}`,
        itemId: ITEM_A,
        startedAt: 2000,
        endedAt: 2000,
        fromPosition: 1000,
        toPosition: to,
      })
    }
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    // 1000 (real) + 50 (deduped storm), NOT 1000 + 150 (raw double-count).
    expect(await repo.getTotalListenedSeconds()).toBe(1050)
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
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    await repo.forceStart({ itemId: ITEM_A, position: 600 })
    const sessions = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions ORDER BY ended_at"
    )
    expect(sessions[1].from_position).toBe(600)
    expect(sessions[1].to_position).toBe(600)
  })

  it("forceStartOnce() raises from_position to what a live row of the same run claimed", async () => {
    // The live tracker already journaled the 10 minutes heard in the
    // foreground, closing at wall-clock 1600 …
    await rawInsert(db, {
      id: "live",
      itemId: ITEM_A,
      startedAt: 1000,
      endedAt: 1600,
      fromPosition: 0,
      toPosition: 600,
    })
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    // … and the native journal re-presents the WHOLE [resume point → end]
    // span of the run that ended at 3400.
    const id = await repo.forceStartOnce({
      itemId: ITEM_A,
      position: 0,
      sourceKey: "queue:1:pi-a:1784000000000",
      runWindow: { fromSec: 1000, toSec: 3460 },
    })
    expect(id).not.toBeNull()
    await repo.finish(id!, { position: 2400 })

    const [journaled] = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions WHERE source_key IS NOT NULL"
    )
    expect(journaled).toMatchObject({ from_position: 600, to_position: 2400 })

    // A log entry that genuinely begins ahead of the mark is left alone.
    const later = await repo.forceStartOnce({
      itemId: ITEM_A,
      position: 3000,
      sourceKey: "queue:2:pi-a:1784000600000",
      runWindow: { fromSec: 1000, toSec: 3460 },
    })
    const [ahead] = await db.query<{ from_position: number }>(
      "SELECT from_position FROM listening_sessions WHERE id = ?",
      [later!]
    )
    expect(ahead?.from_position).toBe(3000)
  })

  it("forceStartOnce() ignores sessions that closed outside the run window", async () => {
    // The lecture was heard to the end long before this run — the only row on
    // the item sits far outside the window. Clamping on the item's ALL-TIME
    // mark would put from_position at 2400 and credit the new listen zero.
    await rawInsert(db, {
      id: "weeks-ago",
      itemId: ITEM_A,
      startedAt: 1000,
      endedAt: 3400,
      fromPosition: 0,
      toPosition: 2400,
    })
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const id = await repo.forceStartOnce({
      itemId: ITEM_A,
      position: 0,
      sourceKey: "queue:9:pi-a:1786000000000",
      runWindow: { fromSec: 1_800_000, toSec: 1_802_460 },
    })
    await repo.finish(id!, { position: 2400 })

    const [replay] = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions WHERE source_key IS NOT NULL"
    )
    expect(replay).toMatchObject({ from_position: 0, to_position: 2400 })
  })

  it("tick() and finish() advance to_position and ended_at", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const id = await repo.start({ itemId: ITEM_A, position: 0 })
    await repo.tick(id, { position: 30 })
    let session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(30)

    await repo.finish(id, { position: 90 })
    session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(90)
  })

  it("tick()/finish() never rewind to_position below the mark (backward scrub keeps high-water)", async () => {
    // Repro of the prod negative-delta rows: a session opened at 775s, then a
    // backward position event (fast scrub to 23s) arrived as a plain tick/finish
    // — NOT through seek(). Without the monotonic guard this wrote from=775,
    // to=23 (delta -752). MAX(to_position, ?) must hold `to` at 775.
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const id = await repo.forceStart({ itemId: ITEM_A, position: 775 })

    await repo.tick(id, { position: 23 })
    let session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(775)

    await repo.finish(id, { position: 23 })
    session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(775)
    // Never a negative delta.
    expect(session!.toPosition - session!.fromPosition).toBeGreaterThanOrEqual(0)
  })

  it("getProgressForItems returns the high-water mark (MAX to_position) per item", async () => {
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const progress = await repo.getProgressForItems([ITEM_A, ITEM_B])
    expect(progress.get(ITEM_A)?.position).toBe(250)
    expect(progress.get(ITEM_A)?.updatedAtSec).toBe(400)
    expect(progress.get(ITEM_B)?.position).toBe(5)
  })

  it("getProgressForItems keeps the high-water mark after a rewind (latest session is lower)", async () => {
    // Listened to 250, then a LATER session rewound to 30. The progress ring
    // (and resume) must not drop to 30 — the user reached 250.
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 250,
    })
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 300,
      endedAt: 400,
      fromPosition: 30,
      toPosition: 30,
    })

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const progress = await repo.getProgressForItems([ITEM_A])
    expect(progress.get(ITEM_A)?.position).toBe(250)
  })

  it("getResumePositionForItem returns the high-water mark, not the latest session", async () => {
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 2400, // 40:00
    })
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 300,
      endedAt: 400,
      fromPosition: 0,
      toPosition: 300, // rewound to 5:00 and stopped
    })

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    expect(await repo.getResumePositionForItem(ITEM_A)).toBe(2400)
    expect(await repo.getResumePositionForItem(ITEM_B)).toBeNull()
  })

  it("getProgressForItems / getLastSessionForItem break whole-second ties deterministically by id", async () => {
    // Two sessions for the same item closed in the SAME second. The tiebreak
    // (id DESC) must pick `a2` (higher id) regardless of insertion order.
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 200,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 700,
    })
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 200,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 100,
    })

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const last = await repo.getLastSessionForItem(ITEM_A)
    expect(last?.id).toBe("a2")
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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

  it("getCompletedAtForItems reports NOT completed once the latest session rewound below threshold", async () => {
    // The user finished the track (to=1000 >= 998), then replayed it and
    // rewound to 5:00 (latest session, to=300). Completion is re-evaluated
    // from the LATEST session, so the track is in-progress again and NOT
    // auto-archive-eligible — consistent with the rewound progress radial.
    await rawInsert(db, {
      id: "a1",
      itemId: ITEM_A,
      startedAt: 100,
      endedAt: 200,
      fromPosition: 0,
      toPosition: 1000,
    })
    await rawInsert(db, {
      id: "a2",
      itemId: ITEM_A,
      startedAt: 300,
      endedAt: 400,
      fromPosition: 0,
      toPosition: 300,
    })

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const result = await repo.getCompletedAtForItems([ITEM_A], new Map([[ITEM_A, 1000]]))
    expect(result.get(ITEM_A)).toBeNull()
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
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

    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    // Lifetime total: 600 (good) + 0 (bad clamped), not 600 + (-1466).
    expect(await repo.getTotalListenedSeconds()).toBe(600)

    const fromMs = new Date("2026-04-14T00:00:00Z").getTime()
    const toMs = new Date("2026-04-17T00:00:00Z").getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    const sum = totals.reduce((acc, x) => acc + x.listenedSeconds, 0)
    expect(sum).toBe(600)
  })
})

describe("useListeningSessionTracker cross-midnight split", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function localDateStr(ms: number): string {
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }

  it("splits a session that crosses local midnight so each day keeps its share", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    // Anchor on a local-midnight so the split boundary is unambiguous,
    // independent of the runner's timezone.
    const midnight = new Date(2026, 3, 16, 0, 0, 0, 0).getTime() // local 2026-04-16 00:00
    const before = midnight - 5 * 60 * 1000 // 23:55 the previous day
    const after = midnight + 5 * 60 * 1000 // 00:05 the next day
    const yesterday = localDateStr(before)
    const today = localDateStr(after)
    expect(yesterday).not.toBe(today)

    // Open the session at 23:55 at track position 1000s.
    vi.setSystemTime(before)
    await tracker.start({ itemId: ITEM_A, positionMs: 1_000_000 })

    // A tick at 00:05 the next day, track now at 1600s — 10 min of audio,
    // 5 of them before midnight and 5 after. The tracker must split.
    vi.setSystemTime(after)
    await tracker.tick({ positionMs: 1_600_000 })

    const rows = await db.query<{
      ended_at: number
      from_position: number
      to_position: number
    }>("SELECT ended_at, from_position, to_position FROM listening_sessions ORDER BY ended_at")
    expect(rows).toHaveLength(2)

    // First (pre-midnight) row is credited to yesterday and ends just before
    // midnight; second (continuation) row is credited to today.
    expect(localDateStr(rows[0].ended_at * 1000)).toBe(yesterday)
    expect(localDateStr(rows[1].ended_at * 1000)).toBe(today)

    // The continuation picks up exactly where the boundary row left off.
    expect(rows[1].from_position).toBe(rows[0].to_position)

    // No listening is lost or double-counted across the split: the whole
    // 10 minutes (1000→1600) is preserved, ~5 min on each local day.
    const fromMs = new Date(2026, 3, 14).getTime()
    const toMs = new Date(2026, 3, 18).getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    const byDate = new Map(totals.map((t) => [t.date, t.listenedSeconds]))
    expect(byDate.get(yesterday)).toBe(300) // 1000→1300
    expect(byDate.get(today)).toBe(300) // 1300→1600
  })

  it("does not split a session that stays within one local day", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    const t = new Date(2026, 3, 16, 10, 0, 0, 0).getTime()
    vi.setSystemTime(t)
    await tracker.start({ itemId: ITEM_A, positionMs: 0 })
    vi.setSystemTime(t + 60_000)
    await tracker.tick({ positionMs: 60_000 })

    const rows = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM listening_sessions")
    expect(rows[0].c).toBe(1)
  })

  it("splits EVERY crossed midnight for a multi-day background gap (no day left at zero)", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    // Session opens at 23:50 on day 0 and the next event (finish) only lands
    // ~3 days later — the app was backgrounded the whole time. The split must
    // emit a row per spanned local day, not credit one slice to day 0 and dump
    // everything else onto the detection day.
    const day0 = new Date(2026, 3, 16, 23, 50, 0, 0).getTime() // local 2026-04-16 23:50
    // 23:50 + 3 days 10min 1s; finish at 00:00:01 on 2026-04-19.
    const finishAt = new Date(2026, 3, 19, 0, 0, 1, 0).getTime()
    // 1ms wall ≈ 1ms audio; open at position 0, end after the elapsed span.
    const endPositionMs = finishAt - day0
    const totalSec = Math.floor(endPositionMs / 1000)

    vi.setSystemTime(day0)
    await tracker.start({ itemId: ITEM_A, positionMs: 0 })

    vi.setSystemTime(finishAt)
    await tracker.finish({ positionMs: endPositionMs })

    const d16 = localDateStr(new Date(2026, 3, 16).getTime())
    const d17 = localDateStr(new Date(2026, 3, 17).getTime())
    const d18 = localDateStr(new Date(2026, 3, 18).getTime())
    const d19 = localDateStr(new Date(2026, 3, 19).getTime())

    const fromMs = new Date(2026, 3, 15).getTime()
    const toMs = new Date(2026, 3, 20).getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    const byDate = new Map(totals.map((t) => [t.date, t.listenedSeconds]))

    // Each spanned local day must carry a non-zero share — NOT all on day 19.
    expect(byDate.get(d16) ?? 0).toBeGreaterThan(0) // 23:50→24:00 = 10 min
    expect(byDate.get(d17) ?? 0).toBeGreaterThan(0) // full day
    expect(byDate.get(d18) ?? 0).toBeGreaterThan(0) // full day
    // Day 16 is a thin 10-minute sliver; the two intervening days carry a full
    // local day each; day 19 carries the remaining ~1-second tail.
    expect(byDate.get(d16)!).toBe(10 * 60)
    expect(byDate.get(d17)!).toBe(24 * 60 * 60)
    expect(byDate.get(d18)!).toBe(24 * 60 * 60)
    expect(byDate.get(d19) ?? 0).toBeGreaterThan(0)
    // The whole listened span is preserved across the four rows (no loss, no
    // double-count) — every second is credited to exactly one local day.
    const sum = [...byDate.values()].reduce((a, b) => a + b, 0)
    expect(sum).toBe(totalSec)

    // One row per spanned local day (16,17,18,19) = 4 rows.
    const rows = await db.query<{ c: number }>("SELECT COUNT(*) AS c FROM listening_sessions")
    expect(rows[0].c).toBe(4)
  })

  it("splits a one-midnight background gap when only finish fires (no tick)", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    // Open at 23:55, then the only event is a finish at 00:05 the next day —
    // no intermediate tick. The split must still happen on finish().
    const midnight = new Date(2026, 3, 16, 0, 0, 0, 0).getTime()
    const before = midnight - 5 * 60 * 1000 // 23:55 prev day
    const after = midnight + 5 * 60 * 1000 // 00:05 next day
    const yesterday = localDateStr(before)
    const today = localDateStr(after)

    vi.setSystemTime(before)
    await tracker.start({ itemId: ITEM_A, positionMs: 1_000_000 })
    vi.setSystemTime(after)
    await tracker.finish({ positionMs: 1_600_000 })

    const rows = await db.query<{
      ended_at: number
      from_position: number
      to_position: number
    }>("SELECT ended_at, from_position, to_position FROM listening_sessions ORDER BY ended_at")
    expect(rows).toHaveLength(2)
    expect(localDateStr(rows[0].ended_at * 1000)).toBe(yesterday)
    expect(localDateStr(rows[1].ended_at * 1000)).toBe(today)
    expect(rows[1].from_position).toBe(rows[0].to_position)

    const fromMs = new Date(2026, 3, 14).getTime()
    const toMs = new Date(2026, 3, 18).getTime()
    const totals = await repo.getDailyTotals(fromMs, toMs)
    const byDate = new Map(totals.map((t) => [t.date, t.listenedSeconds]))
    expect(byDate.get(yesterday)).toBe(300) // 1000→1300
    expect(byDate.get(today)).toBe(300) // 1300→1600
  })
})

describe("startOfNextLocalDay (DST-safe boundary derivation)", () => {
  it("lands on real local midnight regardless of the device timezone", () => {
    // For an arbitrary mid-day instant the next boundary is the following
    // local midnight, and the previous-day floor + this boundary are exactly
    // one calendar day apart in local terms.
    const noon = new Date(2026, 3, 16, 12, 0, 0, 0).getTime()
    const next = startOfNextLocalDay(noon)
    const d = new Date(next)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMilliseconds()).toBe(0)
    expect(d.getDate()).toBe(17) // calendar day advanced by exactly one
  })

  it("derives the boundary by calendar arithmetic, not a fixed +24h offset", () => {
    // This is the DST-safety contract: the boundary is `start-of-day + 1
    // calendar day` re-floored to local midnight. On a 23h/25h DST day a
    // naive `startOfLocalDay + 86_400_000` would miss local midnight by an
    // hour, but the calendar-stepped derivation always hits 00:00 local.
    // We assert the boundary equals local midnight of the NEXT calendar date
    // for a span of dates (covers whatever the runner's TZ does at its own DST
    // transition, if any falls in the range).
    for (let day = 1; day <= 28; day++) {
      // Sample a spring (late-March) and autumn (late-Oct) date — the usual
      // northern-hemisphere DST transition windows.
      for (const month of [2, 9]) {
        const mid = new Date(2026, month, day, 13, 30, 0, 0).getTime()
        const boundary = startOfNextLocalDay(mid)
        const b = new Date(boundary)
        // The boundary is always a real local midnight…
        expect(b.getHours()).toBe(0)
        expect(b.getMinutes()).toBe(0)
        // …and is strictly after the instant it was derived from, by between
        // 23h and 25h (a normal day is 24h; DST days are ±1h).
        const deltaH = (boundary - mid) / 3_600_000
        expect(deltaH).toBeGreaterThan(23 - 13.5) // > 9.5h from 13:30
        expect(deltaH).toBeLessThan(25 - 13.5 + 0.001) // < ~11.5h
      }
    }
  })
})

describe("useListeningSessionTracker finish() failure", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
  })

  it("restores the active-session handle when finish() fails so a retry still closes it", async () => {
    const real = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    let failOnce = true
    const repo = {
      ...real,
      finish: async (id: string, args: { position: number }) => {
        if (failOnce) {
          failOnce = false
          throw new Error("database is locked")
        }
        return real.finish(id, args)
      },
    } as typeof real
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    await tracker.start({ itemId: ITEM_A, positionMs: 0 })

    // First close fails — the handle must survive so the span isn't orphaned.
    await expect(tracker.finish({ positionMs: 60_000 })).rejects.toThrow()
    expect(tracker.hasActiveSession()).toBe(true)

    // Retry closes the SAME session — exactly one row, properly finished.
    await tracker.finish({ positionMs: 60_000 })
    expect(tracker.hasActiveSession()).toBe(false)

    const rows = await db.query<{ to_position: number }>(
      "SELECT to_position FROM listening_sessions"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].to_position).toBe(60)
  })
})

describe("useListeningSessionTracker reentrancy (progress-event storm)", () => {
  let db: IDatabase

  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(db)
  })

  // Faithful reproduction of the player call site (`usePlayerSession.applyStatus`):
  // fire-and-forget, deciding start-vs-tick from the tracker's synchronous
  // guards. Before the fix, `hasActiveSession()` lagged the awaited insert, so
  // a burst of "playing" events each opened its own overlapping session and the
  // activity total ballooned (one 57-min track summed to ~180h in the field).
  function drivePlaying(
    tracker: ReturnType<typeof useListeningSessionTracker>,
    itemId: PlaylistItemId,
    positionMs: number
  ): void {
    if (!tracker.hasActiveSession() || tracker.activeItemId() !== itemId) {
      void tracker.start({ itemId, positionMs }).catch(() => {})
    } else {
      void tracker.tick({ positionMs }).catch(() => {})
    }
  }

  it("a burst of progress events opens exactly one session, not one per event", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    // 300 progress frames delivered in one synchronous burst (position marching
    // forward), none awaited — exactly what the native engine did at 06:24:42.
    for (let i = 0; i < 300; i++) {
      drivePlaying(tracker, ITEM_A, 643_000 + i * 5_000)
    }
    await tracker.finish({ positionMs: 643_000 + 300 * 5_000 })

    const rows = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions"
    )
    // The storm created hundreds of rows; the fix keeps it to a single one.
    expect(rows).toHaveLength(1)

    const totalSec = await repo.getTotalListenedSeconds()
    // One clean interval [643s, 2143s] — 1500s of audio, NOT 300× that.
    expect(totalSec).toBe(2143 - 643)
  })

  it("does not deduplicate a genuine replay after the session is finished", async () => {
    const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
    const tracker = useListeningSessionTracker({ getRepo: () => repo })

    // Listen 0→600, finish, then replay from 0→600 again. Both count.
    await tracker.start({ itemId: ITEM_A, positionMs: 0 })
    await tracker.finish({ positionMs: 600_000 })
    await tracker.start({ itemId: ITEM_A, positionMs: 0 })
    await tracker.finish({ positionMs: 600_000 })

    const rows = await db.query<{ id: string }>("SELECT id FROM listening_sessions")
    expect(rows).toHaveLength(2)
  })

  describe("getCompletedAtForItems batching", () => {
    /** The pre-batching implementation, kept as the parity oracle. */
    async function perItemCompletedAt(
      target: IDatabase,
      itemIds: readonly PlaylistItemId[],
      durations: ReadonlyMap<PlaylistItemId, number>
    ): Promise<Map<PlaylistItemId, number | null>> {
      const result = new Map<PlaylistItemId, number | null>()
      for (const id of itemIds) result.set(id, null)
      for (const itemId of itemIds) {
        const dur = durations.get(itemId)
        if (typeof dur !== "number" || dur <= 0) continue
        const threshold = Math.max(0, dur - COMPLETION_THRESHOLD_SEC)
        const rows = await target.query<{ ended_at: number; to_position: number }>(
          `SELECT ended_at, to_position FROM listening_sessions
            WHERE item_id = ?
            ORDER BY ended_at DESC, id DESC
            LIMIT 1`,
          [itemId]
        )
        if (rows[0] && rows[0].to_position >= threshold) result.set(itemId, rows[0].ended_at)
      }
      return result
    }

    function countingDb(target: IDatabase): { db: IDatabase; queries: () => number } {
      let count = 0
      return {
        db: {
          ...target,
          query: <T>(sql: string, params?: QueryParams): Promise<T[]> => {
            count += 1
            return target.query<T>(sql, params)
          },
        },
        queries: () => count,
      }
    }

    it("matches the per-item implementation across items with, without and tied sessions", async () => {
      const itemIds = ["pi-1", "pi-2", "pi-3", "pi-4", "pi-5", "pi-6"] as PlaylistItemId[]
      // pi-1: finished, then replayed and finished again — latest wins.
      await rawInsert(db, {
        id: "s1a",
        itemId: "pi-1",
        startedAt: 100,
        endedAt: 200,
        fromPosition: 0,
        toPosition: 999,
      })
      await rawInsert(db, {
        id: "s1b",
        itemId: "pi-1",
        startedAt: 300,
        endedAt: 400,
        fromPosition: 0,
        toPosition: 1000,
      })
      // pi-2: finished, then rewound in a later session — not completed.
      await rawInsert(db, {
        id: "s2a",
        itemId: "pi-2",
        startedAt: 100,
        endedAt: 200,
        fromPosition: 0,
        toPosition: 1000,
      })
      await rawInsert(db, {
        id: "s2b",
        itemId: "pi-2",
        startedAt: 300,
        endedAt: 400,
        fromPosition: 0,
        toPosition: 300,
      })
      // pi-3: two sessions closed in the SAME second — `id` breaks the tie,
      // so the higher id (in-progress) decides.
      await rawInsert(db, {
        id: "s3a",
        itemId: "pi-3",
        startedAt: 100,
        endedAt: 500,
        fromPosition: 0,
        toPosition: 1000,
      })
      await rawInsert(db, {
        id: "s3b",
        itemId: "pi-3",
        startedAt: 100,
        endedAt: 500,
        fromPosition: 0,
        toPosition: 10,
      })
      // pi-4: never listened — no rows at all.
      // pi-5: listened but the track duration is unknown (0).
      await rawInsert(db, {
        id: "s5a",
        itemId: "pi-5",
        startedAt: 100,
        endedAt: 200,
        fromPosition: 0,
        toPosition: 1000,
      })
      // pi-6: listened, duration missing from the map entirely.
      await rawInsert(db, {
        id: "s6a",
        itemId: "pi-6",
        startedAt: 100,
        endedAt: 200,
        fromPosition: 0,
        toPosition: 1000,
      })
      const durations = new Map<PlaylistItemId, number>([
        ["pi-1" as PlaylistItemId, 1000],
        ["pi-2" as PlaylistItemId, 1000],
        ["pi-3" as PlaylistItemId, 1000],
        ["pi-4" as PlaylistItemId, 1000],
        ["pi-5" as PlaylistItemId, 0],
      ])

      const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
      const batched = await repo.getCompletedAtForItems(itemIds, durations)
      const expected = await perItemCompletedAt(db, itemIds, durations)

      expect([...batched.entries()].sort()).toEqual([...expected.entries()].sort())
      expect(batched.get("pi-1" as PlaylistItemId)).toBe(400)
      expect(batched.get("pi-2" as PlaylistItemId)).toBeNull()
      expect(batched.get("pi-3" as PlaylistItemId)).toBeNull()
      expect(batched.get("pi-4" as PlaylistItemId)).toBeNull()
      expect(batched.get("pi-5" as PlaylistItemId)).toBeNull()
      expect(batched.get("pi-6" as PlaylistItemId)).toBeNull()
    })

    it("issues one query regardless of how many items are asked for", async () => {
      const itemIds: PlaylistItemId[] = []
      const durations = new Map<PlaylistItemId, number>()
      for (let i = 0; i < 200; i++) {
        const itemId = `pi-${i}` as PlaylistItemId
        itemIds.push(itemId)
        durations.set(itemId, 1000)
        await rawInsert(db, {
          id: `s-${i}`,
          itemId,
          startedAt: 100,
          endedAt: 200 + i,
          fromPosition: 0,
          toPosition: 1000,
        })
      }
      const counting = countingDb(db)
      const repo = createSqlListeningSessionRepository(
        counting.db,
        createSqlUnitOfWork(counting.db)
      )
      const result = await repo.getCompletedAtForItems(itemIds, durations)

      expect(counting.queries()).toBe(1)
      expect([...result.values()].filter((v) => v !== null)).toHaveLength(200)
    })

    it("chunks the ids so a huge union stays under SQLite's parameter limit", async () => {
      // 1200 ids > the 999-parameter floor of older SQLite builds: three
      // chunked queries, not 1200 per-item ones.
      const itemIds: PlaylistItemId[] = []
      const durations = new Map<PlaylistItemId, number>()
      for (let i = 0; i < 1200; i++) {
        const itemId = `pi-${i}` as PlaylistItemId
        itemIds.push(itemId)
        durations.set(itemId, 1000)
      }
      await rawInsert(db, {
        id: "s-1199",
        itemId: "pi-1199",
        startedAt: 100,
        endedAt: 900,
        fromPosition: 0,
        toPosition: 1000,
      })
      const counting = countingDb(db)
      const repo = createSqlListeningSessionRepository(
        counting.db,
        createSqlUnitOfWork(counting.db)
      )
      const result = await repo.getCompletedAtForItems(itemIds, durations)

      expect(counting.queries()).toBe(3)
      expect(result.size).toBe(1200)
      expect(result.get("pi-1199" as PlaylistItemId)).toBe(900)
      expect(result.get("pi-0" as PlaylistItemId)).toBeNull()
    })

    it("stays byte-for-byte equivalent to the per-item read under randomized input", async () => {
      // Seeded so a failure is reproducible. Covers ended_at ties, duplicate
      // and unknown ids, empty input, missing/zero/negative durations and
      // mixed lexical id shapes (the tiebreak compares ids as text).
      let seed = 0x5eed
      const rnd = (): number => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
      const idShapes = ["pi-{n}", "PI_{n}", "item.{n}", "{n}", "z{n}z", "pi-00{n}"]

      const repo = createSqlListeningSessionRepository(db, createSqlUnitOfWork(db))
      for (let trial = 0; trial < 150; trial++) {
        await db.execute("DELETE FROM listening_sessions")
        const itemCount = Math.floor(rnd() * 8)
        const pool: PlaylistItemId[] = []
        for (let i = 0; i < itemCount; i++) {
          pool.push(pick(idShapes).replace("{n}", String(i)) as PlaylistItemId)
        }
        let rowSeq = 0
        for (const itemId of pool) {
          const sessions = Math.floor(rnd() * 5)
          for (let s = 0; s < sessions; s++) {
            // A 3-value ended_at range makes same-second ties common; the
            // session id shape varies so ordering is not just numeric.
            const endedAt = 100 + Math.floor(rnd() * 3)
            const idShape = pick(["ls-{n}", "ls-0{n}", "LS{n}", "{n}"])
            await rawInsert(db, {
              id: idShape.replace("{n}", String(rowSeq++)),
              itemId,
              startedAt: endedAt - 10,
              endedAt,
              fromPosition: 0,
              // Half random, half sitting exactly on a completion boundary
              // (`>= duration - COMPLETION_THRESHOLD_SEC`) for the durations
              // handed out below, so the comparison itself is exercised.
              toPosition:
                rnd() < 0.5
                  ? Math.floor(rnd() * 1200)
                  : pick([997, 998, 999, 1000, 1197, 1198, 1199, 0, 1]),
            })
          }
        }
        // Ask about a shuffled bag: some pool ids twice, some never inserted.
        const asked: PlaylistItemId[] = []
        for (const itemId of pool) {
          if (rnd() < 0.85) asked.push(itemId)
          if (rnd() < 0.2) asked.push(itemId)
        }
        if (rnd() < 0.5) asked.push(`ghost-${trial}` as PlaylistItemId)
        const durations = new Map<PlaylistItemId, number>()
        for (const itemId of asked) {
          const d = pick([1000, 1000, 1200, 1, 0, -5])
          if (rnd() < 0.85) durations.set(itemId, d)
        }

        const batched = await repo.getCompletedAtForItems(asked, durations)
        const expected = await perItemCompletedAt(db, asked, durations)
        // Key order matters: callers iterate the map to build sets.
        expect([...batched.keys()]).toEqual([...expected.keys()])
        expect([...batched.values()]).toEqual([...expected.values()])
      }
    })
  })
})

/** Serialises `transaction()` callers through a promise chain, the way both
 *  real adapters do. `execute()` deliberately bypasses that queue in the
 *  adapters, which is exactly what #1494 is about, so it bypasses it here too. */
function withTxQueue(db: IDatabase): IDatabase {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    ...db,
    transaction(fn: () => Promise<void>): Promise<void> {
      const next = queue.then(() => db.transaction(fn))
      queue = next.then(
        () => undefined,
        () => undefined
      )
      return next
    },
  }
}

describe("listeningSessionsRepository.sql — writes issued during a foreign transaction", () => {
  let queued: IDatabase
  let unitOfWork: IUnitOfWork
  let repo: IListeningSessionRepository

  beforeEach(async () => {
    const raw = await createInMemoryTestDatabase()
    await applyUserSchemaForTests(raw)
    queued = withTxQueue(raw)
    unitOfWork = createReentrantUnitOfWork(queued)
    repo = createSqlListeningSessionRepository(queued, unitOfWork)
  })

  /** Opens a transaction that stays open until `release()`, then throws. Stands
   *  in for a `pullAndMerge` page — one transaction across a whole run of
   *  `applyRemote` awaits — that fails and rolls back. */
  function openFailingTransaction() {
    let open!: () => void
    let release!: () => void
    const opened = new Promise<void>((resolve) => (open = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const running = unitOfWork.run(async () => {
      open()
      await gate
      throw new Error("pull failed")
    })
    return { opened, release, running }
  }

  it("keeps a tick out of the transaction it overlaps", async () => {
    // #1494: `tick` fires off the player's progress cadence, i.e. on a timer,
    // so it lands squarely inside a sync pull's transaction window. As a bare
    // `execute` it joined that transaction on the shared connection, reported
    // success to the caller and vanished on the rollback.
    const id = await repo.forceStart({ itemId: ITEM_A, position: 0 })
    const { opened, release, running } = openFailingTransaction()
    await opened

    const ticked = repo.tick(id, { position: 42 })
    release()
    await expect(running).rejects.toThrow("pull failed")
    await ticked

    const session = await repo.getLastSessionForItem(ITEM_A)
    expect(session?.toPosition).toBe(42)
  })

  it("keeps a newly started session out of the transaction it overlaps", async () => {
    // Same window, the `forceStart` half of #1494: the row inserted for a seek
    // used to disappear with the foreign rollback, so every later tick updated
    // a session that no longer existed.
    const { opened, release, running } = openFailingTransaction()
    await opened

    const started = repo.forceStart({ itemId: ITEM_B, position: 7 })
    release()
    await expect(running).rejects.toThrow("pull failed")
    const id = await started

    const session = await repo.getLastSessionForItem(ITEM_B)
    expect(session?.id).toBe(id)
    expect(session?.fromPosition).toBe(7)
  })
})
