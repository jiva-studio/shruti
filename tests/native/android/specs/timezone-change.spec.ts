import type { ClockSnapshot } from "../src/ports/Clock.js"
import type { ListeningSession } from "../src/ports/ListeningJournal.js"
import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

const PLAY_MS = 25_000
// UTC+14 — whatever the runner's zone, the device's local date and time move.
const FAR_AWAY = "Pacific/Kiritimati"

/**
 * The journal stores instants and the heatmap buckets them by local day, so a
 * user who flies somewhere re-buckets their whole history. Re-bucketing is
 * fine; rewriting or re-importing rows is not.
 */
describe("changing the device timezone", () => {
  const { app, clock, journal, media, journeys, screens } = world()
  let original: ClockSnapshot | undefined
  let recorded: readonly ListeningSession[] = []
  let reread: readonly ListeningSession[] = []

  before(async () => {
    original = await clock.snapshot()
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    await browser.pause(PLAY_MS)
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
    await browser.pause(3_000)
    recorded = await journal.sessions()

    await clock.setTimeZone(FAR_AWAY)
    // The WebView resolves the zone once per process; only a cold start sees it.
    await app.restart()
    await journeys.reopenAfterRestart()
    await journeys.revisitHome()
    reread = await journal.sessions()
  })

  after(async () => {
    if (original) await clock.restore(original)
  })

  it("recorded something to begin with", () => {
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded[0].toPosition).toBeGreaterThan(recorded[0].fromPosition)
  })

  it("leaves every row byte for byte as it was", () => {
    expect(reread).toEqual(recorded)
  })

  it("does not import a second copy of the history", () => {
    expect(new Set(reread.map((session) => session.id)).size).toBe(reread.length)
  })

  it("keeps the listening on a single day and loses none of it", async () => {
    const totals = await journal.dailyTotals()
    const listened = recorded.reduce(
      (sum, session) => sum + (session.toPosition - session.fromPosition),
      0,
    )
    expect(totals.length).toBe(1)
    expect(totals[0].listenedSeconds).toBe(listened)
  })

  it("still shows the user their streak", async () => {
    expect(await screens.activity.streak()).toBeGreaterThanOrEqual(1)
  })
})
