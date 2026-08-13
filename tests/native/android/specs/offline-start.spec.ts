import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/**
 * Smoke: with the device's own network stack down, startup still finishes.
 * The web suite covers what the UI shows offline; only a device can prove that
 * no startup call blocks forever.
 */
describe("offline start", () => {
  const { app, net, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  after(async () => {
    await net.setAirplaneMode(false)
  })

  it("reaches the tab bar and stays responsive", async () => {
    await net.setAirplaneMode(true)
    await app.restart()
    await screens.tabs.waitUntilVisible()
    expect(await app.state()).toBe(AppState.Foreground)
  })
})
