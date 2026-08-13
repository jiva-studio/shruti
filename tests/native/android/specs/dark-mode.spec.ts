import { world } from "../src/world.js"

/**
 * Smoke: the system's night setting reaches the WebView at all. What the app
 * then renders in dark is the web suite's business.
 */
describe("system dark mode reaches the WebView", () => {
  const { ui, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  after(async () => {
    await ui.setNightMode(false)
  })

  it("propagates prefers-color-scheme", async () => {
    await ui.setNightMode(true)
    await browser.waitUntil(() => screens.theme.prefersDark(), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: "the WebView never saw prefers-color-scheme: dark",
    })
  })
})
