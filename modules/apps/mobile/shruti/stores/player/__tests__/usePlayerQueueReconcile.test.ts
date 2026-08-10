import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AudioQueueTransition } from "@ports/app/audioPlayer.js"
import type { IDatabase } from "@ports/app/index.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import { runMigrations } from "@kit/persistence"
import { createSqlAppRepositories } from "@infra/repositories/sql/index.js"
import { createInMemoryTestDatabase } from "@infra/repositories/sql/__tests__/testDb.js"
import { userMigrations } from "@infra/persistence/migrations/user/index.js"
import { usePlayerQueueReconcile } from "../usePlayerQueueReconcile.js"

/**
 * The native journal is durable and only `ackEvents` removes an entry, so an
 * un-acked batch is re-presented on the next launch. These tests replay one
 * against a REAL `listening_sessions` adapter and assert the history is
 * unchanged — the double-counted rows of #1495 would show up here as extra
 * rows and inflated totals.
 *
 * The repository comes from `createSqlAppRepositories`, not from the adapter
 * factory directly: that is what production hands the reconcile path
 * (`app.repositories().listeningSessions`), so the sync-journal decorator is in
 * the loop and a `forceStartOnce` it forgot to delegate fails here. It also
 * keeps this test off the factory's own signature, which #1493 is changing.
 */

let db: IDatabase
let repo: IListeningSessionRepository
let prefs: Map<string, string>
let acked: number[]
let ackFails: boolean
/** `completedAt` per item, as the playlist store would report it. Empty models
 *  the cold start, where nothing has hydrated the map yet. */
let completedAt: Map<string, number | null>
let patched: string[]

vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: vi.fn(),
}))

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({ listeningSessions: repo }),
    preferences: {
      get: async (key: string) => prefs.get(key) ?? null,
      set: async (key: string, value: string) => {
        prefs.set(key, value)
      },
      remove: async (key: string) => {
        prefs.delete(key)
      },
    },
    audioPlayer: {
      ackEvents: async (upToSeq: number) => {
        if (ackFails) throw new Error("bridge torn down")
        acked.push(upToSeq)
      },
    },
  }),
}))

vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    getCompletedAt: (itemId: string) => completedAt.get(itemId) ?? null,
    patchProgress: (itemId: string) => {
      patched.push(itemId)
    },
  }),
}))

function transition(over: Partial<AudioQueueTransition> & { seq: number }): AudioQueueTransition {
  return {
    finishedItemId: "pi-1",
    fromPositionMs: 0,
    finishedAtMs: 600_000,
    durationMs: 3_600_000,
    startedItemId: "pi-2",
    reason: "skip-next",
    at: 1_784_000_000_000 + over.seq * 1000,
    ...over,
  }
}

async function sessionCount(): Promise<number> {
  const rows = await db.query<{ n: number }>("SELECT count(*) AS n FROM listening_sessions")
  return Number(rows[0]!.n)
}

/** Two lock-screen "next" taps on two different lectures. Different items so
 *  the storm-dedup in `getTotalListenedSeconds` can't mask a duplicate row. */
const BATCH: AudioQueueTransition[] = [
  transition({ seq: 1, finishedItemId: "pi-1", fromPositionMs: 0, finishedAtMs: 600_000 }),
  transition({ seq: 2, finishedItemId: "pi-2", fromPositionMs: 0, finishedAtMs: 300_000 }),
]

describe("usePlayerQueueReconcile — replay of an un-acked batch", () => {
  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await runMigrations(db, userMigrations)
    repo = createSqlAppRepositories({
      contentDb: db,
      userDb: db,
      getActiveLanguage: () => "en",
      // Wired, so the repository is the journaled one the app actually uses.
      getDeviceId: async () => "dev-1",
      getOwnerId: () => "user-1",
    }).listeningSessions
    prefs = new Map()
    acked = []
    ackFails = false
    completedAt = new Map()
    patched = []
  })

  it("does not double-count a non-`auto` batch whose ack never landed", async () => {
    // The ack rejects (bridge torn down / process killed straight after).
    ackFails = true
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)

    expect(await sessionCount()).toBe(2)
    expect(await repo.getTotalListenedSeconds()).toBe(900)
    expect(patched).toEqual(["pi-1", "pi-2"])

    // Next launch: a brand-new composable (its in-memory `lastSeq` is 0 again)
    // draining the same, still-unacked journal.
    ackFails = false
    patched = []
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)

    expect(await sessionCount()).toBe(2)
    expect(await repo.getTotalListenedSeconds()).toBe(900)
    // Nothing was folded in, so nothing re-patched the progress map either.
    expect(patched).toEqual([])
    // …but the ack IS retried, which is what finally clears the journal.
    expect(acked).toEqual([2])
  })

  it("still dedups when the persisted watermark is lost too", async () => {
    ackFails = true
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)
    expect(await sessionCount()).toBe(2)

    // Watermark gone as well (the preferences write failed, or the key was
    // dropped): the per-transition source keys are the last line of defence.
    prefs.clear()
    ackFails = false
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)

    expect(await sessionCount()).toBe(2)
    expect(await repo.getTotalListenedSeconds()).toBe(900)
  })

  it("suppresses a cold-start replay of an `auto` transition", async () => {
    // Cold start: `syncFromNative` runs at store construction, before any view
    // has hydrated `completedAt`, so the completion guard cannot fire.
    const auto = transition({
      seq: 7,
      reason: "auto",
      fromPositionMs: 0,
      finishedAtMs: 3_600_000,
    })
    ackFails = true
    await usePlayerQueueReconcile().reconcileAndAck([auto])
    expect(await sessionCount()).toBe(1)
    expect(completedAt.get("pi-1") ?? null).toBeNull()

    prefs.clear()
    ackFails = false
    await usePlayerQueueReconcile().reconcileAndAck([auto])

    expect(await sessionCount()).toBe(1)
    expect(await repo.getTotalListenedSeconds()).toBe(3600)
  })

  it("records genuinely distinct transitions (no over-dedup)", async () => {
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)
    // A later, real skip on the same item — new seq, new wall-clock.
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 3,
        finishedItemId: "pi-1",
        fromPositionMs: 600_000,
        finishedAtMs: 900_000,
      }),
    ])

    expect(await sessionCount()).toBe(3)
    expect(await repo.getTotalListenedSeconds()).toBe(1200)
    expect(acked).toEqual([2, 3])
  })

  it("processes a native counter that restarted below the watermark", async () => {
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)
    expect(prefs.get("player.queue.lastSeq")).toBe("2")

    // A reinstall / cleared app storage restarts the journal at seq 1. Without
    // the regression check the stale watermark would swallow it forever.
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({ seq: 1, finishedItemId: "pi-3", at: 1_790_000_000_000 }),
    ])

    expect(await sessionCount()).toBe(3)
  })

  it("acks only what it drained after a native-counter rewind", async () => {
    await usePlayerQueueReconcile().reconcileAndAck(BATCH)
    expect(prefs.get("player.queue.lastSeq")).toBe("2")
    // Preferences survived a restore, native's counter did not.
    prefs.set("player.queue.lastSeq", "5000")
    acked = []

    await usePlayerQueueReconcile().reconcileAndAck([
      transition({ seq: 1, finishedItemId: "pi-3", at: 1_790_000_000_000 }),
      transition({ seq: 2, finishedItemId: "pi-4", at: 1_790_000_001_000 }),
    ])

    // Acking 5000 would discard transitions native logged after the read, and
    // the watermark would never come back down (#1597).
    expect(acked).toEqual([2])
    expect(prefs.get("player.queue.lastSeq")).toBe("2")
  })
})

/**
 * The gap that let #1623 ship: every case above drains the journal against an
 * EMPTY history. In the real continuous-playback flow the live tracker has
 * already written the part heard in the foreground, and the journal reports the
 * finished item as `[resume point → end]` — the same audio, a second time.
 */
describe("usePlayerQueueReconcile — a live session already covers the item", () => {
  beforeEach(async () => {
    db = await createInMemoryTestDatabase()
    await runMigrations(db, userMigrations)
    repo = createSqlAppRepositories({
      contentDb: db,
      userDb: db,
      getActiveLanguage: () => "en",
      getDeviceId: async () => "dev-1",
      getOwnerId: () => "user-1",
    }).listeningSessions
    prefs = new Map()
    acked = []
    ackFails = false
    completedAt = new Map()
    patched = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Live tracker: `secondsHeard` of `pi-1` journaled in the foreground,
   *  closing at `atMs`. */
  async function liveSession(secondsHeard: number, atMs = 1_784_000_000_000): Promise<void> {
    // Distinct wall-clock per row: same-second rows collapse into one
    // `(item, started_at, ended_at, from_position)` group in the totals, which
    // would mask the duplicate the journal writes.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(atMs)
    const id = await repo.start({ itemId: "pi-1" as never, position: 0 })
    await repo.finish(id, { position: secondsHeard })
    vi.setSystemTime(atMs + 600_000)
  }

  it("does not re-count the foreground prefix on a background auto-advance", async () => {
    // 10 minutes with the app open, then the phone locks and the queue plays
    // the remaining 30 out in the background.
    await liveSession(600)
    // Cold start / background completion, so the `completedAt` echo filter
    // cannot fire — that is the whole point of this path.
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({ seq: 1, reason: "auto", fromPositionMs: 0, finishedAtMs: 2_400_000 }),
    ])

    expect(await sessionCount()).toBe(2)
    // 600 s live + 1800 s background — the lecture is 2400 s long.
    expect(await repo.getTotalListenedSeconds()).toBe(2400)
  })

  it("does not double-count a lock-screen skip over audio the live row claimed", async () => {
    // ⏭ on the lock screen: `reason` is not "auto", so NO filter runs at all
    // and the journal row covers exactly the span the live row already did.
    await liveSession(600)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({ seq: 1, reason: "skip-next", fromPositionMs: 0, finishedAtMs: 600_000 }),
    ])

    expect(await repo.getTotalListenedSeconds()).toBe(600)
  })

  it("credits a lecture finished weeks ago and re-listened entirely in the background", async () => {
    // The #1596 headline. Same shape as the case below, but the item is still
    // an active first-page entry, so the playlist HAS hydrated its
    // `completedAt` — and that map is DB-derived and durable, so an existence
    // test drops this run entirely and records not one second of it.
    const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000
    await liveSession(2400)
    completedAt.set("pi-1", 1_784_000_000_000)

    const at = 1_784_000_000_000 + THREE_WEEKS_MS
    vi.setSystemTime(at)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "auto",
        fromPositionMs: 0,
        finishedAtMs: 2_400_000,
        at,
        fromAt: at - 2_400_000,
      }),
    ])

    expect(await sessionCount()).toBe(2)
    expect(await repo.getTotalListenedSeconds()).toBe(4800)
    expect(patched).toEqual(["pi-1"])
  })

  it("still suppresses a foreground completion echoed by native's `auto` transition", async () => {
    // What the filter exists for: the live tracker journaled the whole lecture
    // in the foreground and set `completedAt`; native then reports the same
    // listen as an `auto` transition. The completion sits INSIDE the run
    // window, so it is still suppressed and the 40 minutes count once.
    const at = 1_784_000_000_000
    await liveSession(2400, at)
    completedAt.set("pi-1", at)

    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "auto",
        fromPositionMs: 0,
        finishedAtMs: 2_400_000,
        at,
        fromAt: at - 2_400_000,
      }),
    ])

    // Filtered out entirely — one row, one listen, no re-patch.
    expect(await sessionCount()).toBe(1)
    expect(await repo.getTotalListenedSeconds()).toBe(2400)
    expect(patched).toEqual([])
  })

  it("falls back to the estimated window for a journal entry with no `fromAt`", async () => {
    // Upgrade mid-queue: entries an older build wrote carry no start stamp and
    // must keep working. A weeks-later background re-listen of a completed
    // lecture is still credited, on the estimate alone.
    const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000
    await liveSession(2400)
    completedAt.set("pi-1", 1_784_000_000_000)

    const at = 1_784_000_000_000 + THREE_WEEKS_MS
    vi.setSystemTime(at)
    await usePlayerQueueReconcile().reconcileAndAck([
      // No `fromAt` — exactly what a pre-#1656 journal replays.
      transition({ seq: 1, reason: "auto", fromPositionMs: 0, finishedAtMs: 2_400_000, at }),
    ])

    expect(await sessionCount()).toBe(2)
    expect(await repo.getTotalListenedSeconds()).toBe(4800)
  })

  it("suppresses an old-format foreground echo on the estimated window", async () => {
    // The fallback's other half: with no stamp the window is estimated from
    // the audio span, and a foreground completion of that same run still lands
    // inside it — so an upgrading user does not double-count either.
    const at = 1_784_000_000_000
    await liveSession(2400, at)
    completedAt.set("pi-1", at)

    await usePlayerQueueReconcile().reconcileAndAck([
      transition({ seq: 1, reason: "auto", fromPositionMs: 0, finishedAtMs: 2_400_000, at }),
    ])

    expect(await sessionCount()).toBe(1)
    expect(await repo.getTotalListenedSeconds()).toBe(2400)
  })

  it("uses the stamped start, not the audio span, to bound the window", async () => {
    // A run paused for half an hour mid-lecture: 40 min of audio spread over
    // 70 min of wall-clock. The estimate reaches back only 40 min from the end
    // and misses the live row, double-counting its prefix; the stamp covers
    // the real span and clamps correctly.
    const startedAt = 1_784_000_000_000
    const endedAt = startedAt + 70 * 60 * 1000
    await liveSession(600, startedAt)

    vi.setSystemTime(endedAt)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "auto",
        fromPositionMs: 0,
        finishedAtMs: 2_400_000,
        at: endedAt,
        fromAt: startedAt,
      }),
    ])

    expect(await sessionCount()).toBe(2)
    // 600 s live + 1800 s background, not 600 + 2400.
    expect(await repo.getTotalListenedSeconds()).toBe(2400)
  })

  it("does not mark a rewound-then-skipped lecture completed", async () => {
    // #1662. Heard almost to the end, rewound to 1:00 (journalJump closes that
    // row near the end), one more minute, then ⏭ on the lock screen. The
    // clamp may only shrink the journal row from the left — pushed past where
    // the run ended it would leave `to_position` at the earlier high-water,
    // and completion is read off the LATEST session, so the sweep would
    // archive the lecture and delete audio the user had just rewound into.
    // One run: the queue started 2399 s of audio ago, so both live rows below
    // close inside its window. The lecture is 2400 s and the completion
    // threshold is 2 s, so that first row alone reads as finished.
    const heardToEndAt = 1_784_000_000_000
    const runStart = heardToEndAt - 2_399_000
    await liveSession(2399, heardToEndAt)

    // Rewound to 1:00, one more minute — the latest session is now [60, 121],
    // which is what makes the lecture correctly in-progress again.
    vi.setSystemTime(heardToEndAt + 61_000)
    const rewound = await repo.start({ itemId: "pi-1" as never, position: 60 })
    await repo.finish(rewound, { position: 121 })

    // The drain runs when the app next foregrounds, so the journal row is
    // stamped strictly after the rewind row — otherwise the two tie on
    // `ended_at` and "the latest session" turns on an id tiebreak.
    const skippedAt = heardToEndAt + 61_000
    vi.setSystemTime(skippedAt + 30_000)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "skip-next",
        fromPositionMs: 0,
        finishedAtMs: 121_000,
        at: skippedAt,
        fromAt: runStart,
      }),
    ])

    // The journal row must not claim the run reached the end.
    const [journaled] = await db.query<{ from_position: number; to_position: number }>(
      "SELECT from_position, to_position FROM listening_sessions WHERE source_key IS NOT NULL"
    )
    expect(journaled!.to_position).toBe(121)
    // …and it must never store a negative interval either.
    expect(journaled!.to_position).toBeGreaterThanOrEqual(journaled!.from_position)

    // Which is what keeps the lecture out of the sweep: completion reads the
    // latest session, and 121 s of a 2400 s lecture is not finished.
    const completed = await repo.getCompletedAtForItems(
      ["pi-1" as never],
      new Map([["pi-1" as never, 2400]])
    )
    expect(completed.get("pi-1" as never)).toBeNull()
  })

  it("does not mark it completed when a pause puts the run's reach beyond the audio span", async () => {
    // Where #1662 and #1656 meet. Same rewind-then-skip, but paused half an
    // hour before the rewind. The OLD estimated window reached back only the
    // 121 s of audio this run played, so it never saw the near-the-end row and
    // the defect stayed hidden; the exact `fromAt` window covers the whole run
    // and does see it. Stamping the start therefore makes #1662 fire in cases
    // that used to be out of reach — the cap is what keeps that safe.
    const heardToEndAt = 1_784_000_000_000
    const runStart = heardToEndAt - 2_399_000
    await liveSession(2399, heardToEndAt)

    const rewoundAt = heardToEndAt + 1_800_000 + 61_000
    vi.setSystemTime(rewoundAt)
    const rewound = await repo.start({ itemId: "pi-1" as never, position: 60 })
    await repo.finish(rewound, { position: 121 })

    vi.setSystemTime(rewoundAt + 30_000)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "skip-next",
        fromPositionMs: 0,
        finishedAtMs: 121_000,
        at: rewoundAt,
        fromAt: runStart,
      }),
    ])

    const completed = await repo.getCompletedAtForItems(
      ["pi-1" as never],
      new Map([["pi-1" as never, 2400]])
    )
    expect(completed.get("pi-1" as never)).toBeNull()
  })

  it("credits in full a lecture re-listened entirely in the background weeks later", async () => {
    // Heard end to end three weeks ago — the item's all-time mark is the whole
    // 40 minutes. Clamping on position would put this run's `from` at 2400 and
    // credit the re-listen nothing.
    const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000
    await liveSession(2400)

    // Queued and played out entirely with the phone locked, so there is no
    // live row for THIS run at all.
    const at = 1_784_000_000_000 + THREE_WEEKS_MS
    vi.setSystemTime(at)
    await usePlayerQueueReconcile().reconcileAndAck([
      transition({
        seq: 1,
        reason: "auto",
        fromPositionMs: 0,
        finishedAtMs: 2_400_000,
        at,
      }),
    ])

    expect(await sessionCount()).toBe(2)
    // Both listens count: 2400 s then and 2400 s now.
    expect(await repo.getTotalListenedSeconds()).toBe(4800)
  })
})
