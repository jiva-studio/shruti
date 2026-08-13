import { world } from "../src/world.js"

describe("removing a track frees its file", () => {
  const { storage, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.queueFirstTrack()
    await browser.waitUntil(async () => (await storage.audioFiles()).length > 0, {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: "nothing was downloaded to remove",
    })
  })

  it("deletes the audio from disk", async () => {
    await screens.tabs.go("home")
    await screens.queue.removeFirst()
    await browser.waitUntil(async () => (await storage.audioFiles()).length === 0, {
      timeout: 60_000,
      interval: 2_000,
      timeoutMsg: "the audio file outlived the queue entry",
    })
  })
})
