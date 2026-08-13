import { AppState } from "../src/ports/AppLifecycle.js"
import { APP_PACKAGE, world } from "../src/world.js"

describe("cold start", () => {
  const { app, webView, screens } = world()

  it("resumes the main activity", async () => {
    expect(await app.currentActivity()).toContain("MainActivity")
  })

  it("publishes a Capacitor WebView context", async () => {
    const contexts = await webView.contexts()
    expect(contexts).toContain("NATIVE_APP")
    expect(contexts).toContain(`WEBVIEW_${APP_PACKAGE}`)
  })

  it("renders onboarding inside the WebView", async () => {
    await screens.onboarding.waitUntilVisible()
    expect(await screens.onboarding.isVisible()).toBe(true)
  })

  it("stays in the foreground", async () => {
    await webView.leave()
    expect(await app.state()).toBe(AppState.Foreground)
  })
})
