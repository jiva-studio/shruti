import type { ClockSnapshot } from "../src/ports/Clock.js"
import type { ListeningSession } from "../src/ports/ListeningJournal.js"
import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

// The journal ticks every 15 s, and only a tick (or the close) can notice the
// day has rolled — a shorter listen leaves nothing to split.
const TICK_MS = 15_000
const BEFORE_MIDNIGHT_MS = 20_000

/**
 * A lecture playing at midnight belongs to two days, and only the device can
 * tell us which: the split is driven by the OS's local calendar, so the web
 * suite can exercise the arithmetic but never the rollover itself.
 */
describe("a session that crosses midnight", () => {
  const { clock, journal, media, journeys } = world()
  let original: ClockSnapshot | undefined
  let sessions: readonly ListeningSession[] = []
  let openingDay = ""
  let nextDay = ""

  before(async () => {
    original = await clock.snapshot()
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    // One tick's worth of listening, so the row that gets split has content.
    await browser.pause(TICK_MS + 5_000)

    openingDay = await clock.today()
    await clock.set(new Date((await clock.nextMidnight()).getTime() - BEFORE_MIDNIGHT_MS))
    // Two ticks: the first still lands on the opening day and only re-arms the
    // throttle, the second is the one that finds the calendar has moved.
    await browser.pause(BEFORE_MIDNIGHT_MS + 2 * TICK_MS + 5_000)
    nextDay = await clock.today()

    // Pause, or playback keeps opening rows underneath the assertions.
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
    await browser.pause(3_000)
    sessions = await journal.sessions()
  })

  after(async () => {
    if (original) await clock.restore(original)
  })

  it("rolled the device onto the next day mid-playback", () => {
    expect(nextDay).not.toBe(openingDay)
  })

  it("leaves one row per day", async () => {
    expect(sessions.length).toBe(2)
    expect((await journal.dailyTotals()).map((total) => total.date)).toEqual([openingDay, nextDay])
  })

  it("closes the first row before the day it opened on ends", () => {
    expect(sessions[0].endedAt).toBeLessThan(sessions[1].startedAt)
  })

  it("hands the position over without a gap", () => {
    expect(sessions[1].fromPosition).toBe(sessions[0].toPosition)
  })

  it("credits both days something", async () => {
    for (const total of await journal.dailyTotals()) {
      expect(total.listenedSeconds).toBeGreaterThan(0)
    }
  })

  it("counts the listening once, not twice", async () => {
    const totals = await journal.dailyTotals()
    const credited = totals.reduce((sum, total) => sum + total.listenedSeconds, 0)
    expect(credited).toBe(sessions[1].toPosition - sessions[0].fromPosition)
  })
})
