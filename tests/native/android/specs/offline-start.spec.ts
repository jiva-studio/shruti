import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

describe("offline start", () => {
  const { app, net, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  after(async () => {
    await net.setAirplaneMode(false)
  })

  it("boots to the tab bar with no network", async () => {
    await net.setAirplaneMode(true)
    await app.restart()
    await screens.tabs.waitUntilVisible()
  })

  it("stays in the foreground instead of hanging", async () => {
    expect(await app.state()).toBe(AppState.Foreground)
  })
})
