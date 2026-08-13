import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * Headphones out, speaker on: the moment the OS announces the route change the
 * engine has to pause, or a lecture plays out loud to the whole room.
 */
describe("audio route becoming noisy", () => {
  const { events, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  it("pauses when the route goes noisy", async () => {
    await events.broadcastAsRoot("android.media.AUDIO_BECOMING_NOISY")
    await media.waitUntilState(PlaybackState.Paused)
  })

  it("stays paused until the user says otherwise", async () => {
    await browser.pause(5_000)
    expect(await media.state()).toBe(PlaybackState.Paused)
  })

  it("resumes on a system play", async () => {
    await media.dispatch("play")
    await media.waitUntilState(PlaybackState.Playing)
  })
})
