import { world } from "../src/world.js"

const ROUNDS = Number(process.env.COLD_START_ROUNDS ?? 8)

/** Repeated cold starts expose leaks that a single start never shows. */
describe("repeated cold starts", () => {
  const { app, logs, memory, journeys } = world()
  let first = 0
  let last = 0

  before(async () => {
    await journeys.startFresh()
    await logs.clear()
  })

  it("starts cleanly every time", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await app.restart()
      await browser.pause(2_000)
      const used = await memory.totalPssKb()
      if (round === 0) first = used
      last = used
    }
    expect(await logs.errorLines()).toEqual([])
  })

  it("does not grow without bound", () => {
    // Generous: this catches a leak that doubles the footprint, not jitter.
    expect(last).toBeLessThan(first * 1.8)
  })
})
