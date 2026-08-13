import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

describe("playback with the screen off", () => {
  const { ui, media, journeys } = world()

  after(async () => {
    await ui.setScreenOn(true)
  })

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  it("keeps playing after the screen goes dark", async () => {
    await ui.setScreenOn(false)
    expect(await ui.isScreenOn()).toBe(false)
    await browser.pause(8_000)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })

  it("is still playing when the screen comes back", async () => {
    await ui.setScreenOn(true)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })
})
