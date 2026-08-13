import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

const EVENTS = Number(process.env.MONKEY_EVENTS ?? 400)

describe("random input storm", () => {
  const { app, logs, stress, journeys } = world()

  before(async () => {
    await journeys.startFresh()
    await logs.clear()
  })

  it("survives random taps and swipes", async () => {
    await stress.randomEvents(EVENTS)
    await app.returnToForeground()
    expect(await app.state()).toBe(AppState.Foreground)
  })

  it("logs no crash or ANR", async () => {
    expect(await logs.errorLines()).toEqual([])
  })
})
