import type { ClockSnapshot } from "../src/ports/Clock.js"
import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

const PLAY_MS = 25_000
/** Mid-morning of the next local day — nowhere near a boundary. */
const INTO_NEXT_DAY_MS = 10 * 60 * 60 * 1000

/**
 * "Today" for the heatmap is the device's local day, not the server's and not
 * the runner's. Only a device can move that day, so this is where the streak
 * is worth checking end to end.
 */
describe("activity follows the device's own date", () => {
  const { app, clock, journal, media, journeys, screens } = world()
  let original: ClockSnapshot | undefined
  let firstDay = ""

  async function listenBriefly(): Promise<void> {
    await journeys.playFirstQueued()
    await media.waitUntilPlaying()
    await browser.pause(PLAY_MS)
    // Pausing closes the open session; leaving it playing would let the next
    // clock jump split it and credit the following day on its own.
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
    await browser.pause(3_000)
  }

  before(async () => {
    original = await clock.snapshot()
    await journeys.startFresh()
    await journeys.queueFirstTrack()
    firstDay = await clock.today()
    await listenBriefly()
  })

  after(async () => {
    if (original) await clock.restore(original)
  })

  it("credits the listening to the day the device is on", async () => {
    const totals = await journal.dailyTotals()
    expect(totals.map((total) => total.date)).toEqual([firstDay])
    expect(totals[0].listenedSeconds).toBeGreaterThan(0)
  })

  it("lights today's cell and opens a one-day streak", async () => {
    await journeys.revisitHome()
    expect(await screens.activity.isVisible()).toBe(true)
    await browser.waitUntil(async () => (await screens.activity.streak()) === 1, {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: "the streak never reached one day",
    })
    expect(await screens.activity.todayHasListening()).toBe(true)
  })

  it("extends the streak when the device rolls into the next day", async () => {
    await clock.set(new Date((await clock.nextMidnight()).getTime() + INTO_NEXT_DAY_MS))
    // Cold start, so nothing is left holding a pre-roll idea of "today".
    await app.restart()
    await journeys.reopenAfterRestart()
    const secondDay = await clock.today()
    expect(secondDay).not.toBe(firstDay)

    await listenBriefly()
    const totals = await journal.dailyTotals()
    expect(totals.map((total) => total.date)).toEqual([firstDay, secondDay])

    await journeys.revisitHome()
    await browser.waitUntil(async () => (await screens.activity.streak()) === 2, {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: "the streak never reached two days",
    })
    expect(await screens.activity.todayHasListening()).toBe(true)
  })
})
