import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * The commonest thing that happens to a listener: the signal goes while the
 * lecture is running. `download-offline` starts playback with the radio
 * already off; this one takes the radio away mid-lecture, which is when a
 * torn-down foreground service costs the user their place and their shade
 * controls.
 */
describe("the network going away mid-lecture", () => {
  const { net, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await net.setAirplaneMode(false)
  })

  it("keeps playing, and keeps the shade controls", async () => {
    await net.setAirplaneMode(true)
    await browser.pause(10_000)
    expect(await media.state()).toBe(PlaybackState.Playing)
    expect(await media.hasShadeNotification()).toBe(true)
  })

  it("is still the same lecture when the signal comes back", async () => {
    const before = await media.positionMs()
    await net.setAirplaneMode(false)
    await browser.pause(5_000)
    expect(await media.state()).toBe(PlaybackState.Playing)
    expect(await media.positionMs()).toBeGreaterThan(before ?? 0)
  })
})
