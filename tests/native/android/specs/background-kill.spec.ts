import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/** The common real-world death: the user leaves, the system reclaims the process. */
describe("process reclaimed in the background", () => {
  const { app, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  it("comes back to a usable app", async () => {
    await app.killWhileBackgrounded()
    await app.returnToForeground()
    await screens.tabs.waitUntilVisible()
    expect(await app.state()).toBe(AppState.Foreground)
  })

  it("does not replay onboarding", async () => {
    expect(await screens.onboarding.isVisible()).toBe(false)
  })
})
