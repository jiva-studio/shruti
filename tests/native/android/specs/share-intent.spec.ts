import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/**
 * Sharing leaves the WebView: `@capacitor/share` builds an ACTION_SEND intent
 * and asks the system to resolve it, so the proof is an activity that is not
 * ours on top — and the app still being where the user left it when they back
 * out of that activity.
 */
describe("sharing a track hands it to the system", () => {
  const { app, ui, chooser, journeys, screens } = world()

  before(async () => {
    await journeys.startFresh()
  })

  it("opens the system chooser", async () => {
    await journeys.shareFirstTrackLink()
    await chooser.waitUntilOpen()
  })

  it("returns to the app when the chooser is dismissed", async () => {
    await ui.pressBack()
    await chooser.waitUntilClosed()
    expect(await app.state()).toBe(AppState.Foreground)
    // Backing out of the chooser is not backing out of the app: the track
    // sheet the share started from is still open.
    expect(await screens.sheet.isClosed()).toBe(false)
  })
})
