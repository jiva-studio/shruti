import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

describe("hardware back button", () => {
  const { app, ui, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  it("closes the track sheet instead of leaving the app", async () => {
    await screens.tabs.go("search")
    await screens.search.openFirstTrack()
    await ui.pressBack()
    expect(await screens.sheet.isClosed()).toBe(true)
    expect(await app.state()).toBe(AppState.Foreground)
  })

  it("minimizes the app from the root tab", async () => {
    // A root tab means an empty history; the steps above left some behind.
    await app.restart()
    await screens.tabs.waitUntilVisible()
    await ui.pressBack()
    await browser.waitUntil(async () => (await app.state()) === AppState.Background, {
      timeout: 15_000,
      interval: 1_000,
      timeoutMsg: "the app stayed in the foreground",
    })
  })

  it("comes back with its state intact", async () => {
    await app.returnToForeground()
    await screens.tabs.waitUntilVisible()
    expect(await screens.onboarding.isVisible()).toBe(false)
  })
})
