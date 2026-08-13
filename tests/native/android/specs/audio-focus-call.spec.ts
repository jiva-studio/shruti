import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

describe("incoming call", () => {
  const { phone, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await phone.endCall()
  })

  it("pauses while the phone rings", async () => {
    await phone.incomingCall()
    await media.waitUntilState(PlaybackState.Paused)
  })

  it("does not resume on its own before the call ends", async () => {
    expect(await media.state()).toBe(PlaybackState.Paused)
  })
})
