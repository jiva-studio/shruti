import { world } from "../src/world.js"

/**
 * Smoke: the download plugin writes real bytes to real storage and they play
 * with the radio off. Retries, limits and dedup live in the web suite.
 */
describe("download reaches the disk", () => {
  const { net, storage, media, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await journeys.queueFirstTrack()
  })

  after(async () => {
    await net.setAirplaneMode(false)
  })

  it("plays from disk with the network off", async () => {
    await browser.waitUntil(async () => (await storage.audioFiles()).length > 0, {
      timeout: 120_000,
      interval: 3_000,
      timeoutMsg: "the download never landed on disk",
    })
    await net.setAirplaneMode(true)
    await journeys.playFirstQueued()
    await media.waitUntilPlaying()
  })
})
