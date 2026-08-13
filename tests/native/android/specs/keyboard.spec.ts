import { world } from "../src/world.js"

describe("soft keyboard", () => {
  const { ui, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  it("opens when the search field takes focus", async () => {
    await screens.tabs.go("search")
    await screens.search.focusSearchField()
    await browser.waitUntil(() => ui.isKeyboardShown(), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: "the keyboard never came up",
    })
  })

  it("closes on back without leaving the app", async () => {
    await ui.pressBack()
    await browser.waitUntil(async () => !(await ui.isKeyboardShown()), {
      timeout: 20_000,
      interval: 1_000,
      timeoutMsg: "the keyboard stayed up",
    })
  })
})
