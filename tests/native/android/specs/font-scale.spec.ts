import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/** Smoke: a system font scale reaches the WebView instead of crashing it. */
describe("system font scale", () => {
  const { app, ui, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  after(async () => {
    await ui.setFontScale(1)
  })

  it("keeps the app usable at 1.5x", async () => {
    await ui.setFontScale(1.5)
    await app.restart()
    await screens.tabs.waitUntilVisible()
    expect(await app.state()).toBe(AppState.Foreground)
  })
})
