import { world } from "../src/world.js"

/**
 * Transport commands arrive from the OS (shade, headset, car), not from the UI.
 * The native queue is only handed to the engine for a subscriber with Autoplay
 * on; otherwise the app plays one track at a time and there is nothing to skip.
 */
describe("system transport controls", () => {
  const { app, entitlement, media, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await entitlement.set("pro")
    // A hard kill would drop the WebView's localStorage before it hits disk.
    await app.sendToBackground(3)
    await app.restart()
    await screens.tabs.waitUntilVisible()

    await screens.tabs.go("settings")
    await screens.settings.enable("Autoplay")

    await journeys.queueTrackAt(0)
    await journeys.queueTrackAt(1)
    await journeys.playFirstQueued()
    await media.waitUntilPlaying()
  })

  after(async () => {
    await entitlement.set("default")
  })

  it("publishes the track title as session metadata", async () => {
    expect(await media.trackTitle()).toBeTruthy()
  })

  it("advertises seeking and previous", async () => {
    const actions = await media.transportActions()
    expect(actions.previous).toBe(true)
    expect(actions.seek).toBe(true)
  })

  it("advertises next once the engine holds the queue", async () => {
    await browser.waitUntil(async () => (await media.transportActions()).next, {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: "the session never advertised SKIP_TO_NEXT",
    })
  })
})
