import { world } from "../src/world.js"

/** SQLite lives behind a native plugin; a kill mid-write is where it corrupts. */
describe("database survives a kill mid-write", () => {
  const { app, media, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    // The listening journal writes every 15 s; land the kill inside that window.
    await browser.pause(16_000)
    await app.forceStop()
  })

  it("reopens and reaches the library", async () => {
    await app.launch()
    await screens.tabs.waitUntilVisible()
  })

  it("kept the queued track", async () => {
    await screens.tabs.go("home")
    expect(await screens.queue.isEmpty()).toBe(false)
  })
})
