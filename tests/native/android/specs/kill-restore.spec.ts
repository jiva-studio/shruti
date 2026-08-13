import { world } from "../src/world.js"

// The journal ticks every 15 s, so a shorter play leaves nothing to resume from.
const PLAY_MS = 25_000

describe("listening position survives a process kill", () => {
  const { app, media, journeys } = world()
  let stoppedAt = 0

  before(async () => {
    await journeys.startFresh()
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
    await browser.pause(PLAY_MS)
    // Backgrounding flushes pending progress, as it does for a real user.
    await app.sendToBackground(4)
    stoppedAt = (await media.positionMs()) ?? 0
  })

  it("played past the journal tick", () => {
    expect(stoppedAt).toBeGreaterThan(20_000)
  })

  it("resumes near where it stopped after a cold restart", async () => {
    await app.restart()
    await journeys.reopenAfterRestart()
    await journeys.playFirstQueued()

    await media.waitUntilPlaying()
    expect((await media.positionMs()) ?? 0).toBeGreaterThan(stoppedAt - 15_000)
  })
})
