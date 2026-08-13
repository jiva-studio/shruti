import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

describe("system media buttons", () => {
  const { media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  it("pauses when the system dispatches pause", async () => {
    await media.dispatch("pause")
    await media.waitUntilState(PlaybackState.Paused)
  })

  it("resumes when the system dispatches play", async () => {
    await media.dispatch("play")
    await media.waitUntilState(PlaybackState.Playing)
  })
})
