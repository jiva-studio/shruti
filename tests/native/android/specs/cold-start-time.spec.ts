import { world } from "../src/world.js"

const BUDGET_MS = Number(process.env.COLD_START_BUDGET_MS ?? 6_000)

describe("cold start cost", () => {
  const { app, logs } = world()

  it("reaches first frame within the budget", async () => {
    await app.forceStop()
    await logs.clear()
    const { totalMs } = await app.measureColdStart()
    expect(totalMs).toBeLessThan(BUDGET_MS)
  })

  it("logs no ANR or runtime crash", async () => {
    await browser.pause(8_000)
    expect(await logs.errorLines()).toEqual([])
  })
})
