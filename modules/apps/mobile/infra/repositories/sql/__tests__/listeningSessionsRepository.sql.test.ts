import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IDatabase } from "@ports/app/index.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import {
  startOfNextLocalDay,
  useListeningSessionTracker,
} from "@lectorium/composables/useListeningSessionTracker.js"
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

    const repo = createSqlListeningSessionRepository(db)
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

    const repo = createSqlListeningSessionRepository(db)
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

    const repo = createSqlListeningSessionRepository(db)
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

    const repo = createSqlListeningSessionRepository(db)
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

    const repo = createSqlListeningSessionRepository(db)
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
    const repo = createSqlListeningSessionRepository(db)
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
    const repo = createSqlListeningSessionRepository(db)
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
    const repo = createSqlListeningSessionRepository(db)
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
    const repo = createSqlListeningSessionRepository(db)
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
