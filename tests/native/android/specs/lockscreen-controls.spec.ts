import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * With the display asleep the app is out of reach, but its transport surface is
 * not: the notification the lock screen renders stays up and system play/pause
 * still lands. The AVD has no secure keyguard, so "locked" here is the display
 * asleep — the state those controls are used in.
 */
describe("controls with the screen locked", () => {
  const { ui, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    await ui.setScreenOn(false)
  })

  after(async () => {
    await ui.setScreenOn(true)
  })

  it("keeps the media notification up", async () => {
    expect(await ui.isScreenOn()).toBe(false)
    expect(await media.hasShadeNotification()).toBe(true)
  })

  it("pauses on a system dispatch", async () => {
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
    expect(await media.hasShadeNotification()).toBe(true)
  })

  it("resumes on a system dispatch", async () => {
    await media.dispatch("play")
    await media.waitUntilState(PlaybackState.Playing)
    expect(await ui.isScreenOn()).toBe(false)
  })
})
