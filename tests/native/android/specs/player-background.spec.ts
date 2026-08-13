import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

describe("background playback", () => {
  const { app, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
  })

  it("reports a playing media session", async () => {
    await media.waitUntilPlaying()
    expect(await media.state()).toBe(PlaybackState.Playing)
  })

  it("keeps playing while the app is in the background", async () => {
    await app.sendToBackground(8)
    expect(await media.state()).toBe(PlaybackState.Playing)
  })

  it("owns a notification in the shade", async () => {
    expect(await media.hasShadeNotification()).toBe(true)
  })
})
