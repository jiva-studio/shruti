import { PlaybackState } from "../src/ports/MediaSession.js"
import { world } from "../src/world.js"

/**
 * A subscriber with Autoplay on hands the whole queue to the native engine, so
 * the end of a track is the engine's business alone — the WebView may well be
 * suspended when it happens. Only a device can show that advance.
 */
describe("autoplay through the queue", () => {
  const { app, backend, entitlement, media, journeys, screens } = world()
  let second: string

  before(async () => {
    // A track has to end inside the test, and the app plays the bytes it was
    // served — so the short fixture is chosen before anything is queued.
    await backend.useAudioFixture("short")
    await journeys.startFresh()
    await entitlement.set("pro")
    // A hard kill would drop the WebView's localStorage before it hits disk.
    await app.sendToBackground(3)
    await app.restart()
    await screens.tabs.waitUntilVisible()

    await screens.tabs.go("settings")
    await screens.settings.enable("Autoplay")

    await journeys.queueTrackAt(0)
    second = await journeys.queueTrackAt(1)
    await journeys.playFirstQueued()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await entitlement.set("default")
    await backend.useAudioFixture("default")
  })

  it("advances to the next queued item", async () => {
    await media.waitUntilTrackTitle(second)
  })

  it("stops once the last item ends", async () => {
    await media.waitUntilNotPlaying()
  })

  it("does not start the queue over", async () => {
    await browser.pause(8_000)
    expect(await media.state()).not.toBe(PlaybackState.Playing)
  })
})
