import { world } from "../src/world.js"

describe("downloaded track plays offline", () => {
  const { net, storage, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.queueFirstTrack()
  })

  after(async () => {
    await net.setAirplaneMode(false)
  })

  it("writes the audio to app storage", async () => {
    await browser.waitUntil(async () => (await storage.audioFiles()).length > 0, {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: "the download never landed on disk",
    })
  })

  it("plays it with the network off", async () => {
    await net.setAirplaneMode(true)
    await journeys.playFirstQueued()
    await media.waitUntilPlaying()
  })
})
