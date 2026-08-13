import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/** Android 13+ gates notifications; the player must survive a refusal. */
describe("notification permission", () => {
  const { app, permissions, media, journeys, screens } = world()

  before(async () => {
    await permissions.revoke("POST_NOTIFICATIONS")
    await app.restart()
    await journeys.startFresh()
  })

  after(async () => {
    await permissions.grant("POST_NOTIFICATIONS")
  })

  it("starts without the permission", async () => {
    expect(await permissions.isGranted("POST_NOTIFICATIONS")).toBe(false)
    await screens.tabs.waitUntilVisible()
    expect(await app.state()).toBe(AppState.Foreground)
  })

  it("still plays audio", async () => {
    await journeys.playFirstTrack()
    await media.waitUntilPlaying()
  })

  it("shows the media notification once granted", async () => {
    await permissions.grant("POST_NOTIFICATIONS")
    await browser.waitUntil(() => media.hasShadeNotification(), {
      timeout: 30_000,
      interval: 2_000,
      timeoutMsg: "no media notification after granting the permission",
    })
  })
})
