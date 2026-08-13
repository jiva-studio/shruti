import { world } from "../src/world.js"

/**
 * targetSdk 36 makes the window edge-to-edge with no opt-out, so the app draws
 * under the status bar and the notch and owes the inset back itself. There are
 * two ways it can: Chromium resolves `env(safe-area-inset-*)` and the page pads
 * itself, or — on a WebView too old for that — the bridge insets the whole view
 * and hands the page zero. Only the pixel the content actually lands on tells
 * both stories, so that is what is measured; a screenshot could not tell a
 * respected inset from a lucky background colour either way.
 */
describe("edge-to-edge under a display cutout", () => {
  const { app, cutout, journeys, screens } = world()

  before(async () => {
    await cutout.enable("tall")
    // Restart rather than trust a live display change: the WebView is then
    // built with the cutout already there, whatever Chromium does on the fly.
    await app.restart()
    await journeys.startFresh()
  })

  after(async () => {
    await cutout.disable()
  })

  it("starts the page below the cutout the display reports", async () => {
    const notch = await cutout.topInsetPx()
    expect(notch).toBeGreaterThan(0)
    expect(await screens.safeArea.contentTopDevicePx()).toBeGreaterThanOrEqual(notch)
  })

  it("charges the page for the notch once", async () => {
    // The bridge either pads the view or lets `env()` through, never both —
    // paying twice would cost the user a second notch of screen.
    const { top } = await screens.safeArea.insets()
    const viewTop = await screens.safeArea.viewportTopDevicePx()
    expect(top > 0 && viewTop > 0).toBe(false)
  })
})
