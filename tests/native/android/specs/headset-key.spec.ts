import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/** The play-pause key on headphones is a media button, not an app gesture. */
describe("headset play-pause key", () => {
  const { ui, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  it("pauses on the first press", async () => {
    await ui.pressMediaPlayPause()
    await media.waitUntilState(PlaybackState.Paused)
  })

  it("resumes on the second", async () => {
    await ui.pressMediaPlayPause()
    await media.waitUntilState(PlaybackState.Playing)
  })
})
