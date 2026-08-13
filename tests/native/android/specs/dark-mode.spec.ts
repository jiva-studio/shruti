import { world } from "../src/world.js"

describe("system dark mode", () => {
  const { ui, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  after(async () => {
    await ui.setNightMode(false)
  })

  it("follows the system into dark", async () => {
    await ui.setNightMode(true)
    await browser.waitUntil(() => screens.theme.prefersDark(), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: "the WebView never saw prefers-color-scheme: dark",
    })
  })

  it("follows it back to light", async () => {
    await ui.setNightMode(false)
    await browser.waitUntil(async () => !(await screens.theme.prefersDark()), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: "the WebView stayed dark",
    })
  })
})
