import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/** Doze is where naive background work dies; a foreground service must not. */
describe("playback under Doze", () => {
  const { app, power, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await power.wake()
    await power.resetBattery()
  })

  it("survives the device going idle", async () => {
    await app.leaveInBackground()
    await power.unplug()
    await power.forceDoze()
    await browser.pause(10_000)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })
})
