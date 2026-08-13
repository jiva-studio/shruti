import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

describe("rotation", () => {
  const { ui, media, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await ui.rotate("PORTRAIT")
  })

  it("keeps playing in landscape", async () => {
    await ui.rotate("LANDSCAPE")
    expect(await media.state()).toBe(PlaybackState.Playing)
  })

  it("keeps the WebView state after rotating back", async () => {
    await ui.rotate("PORTRAIT")
    expect(await screens.player.isVisible()).toBe(true)
  })
})
