import { world } from "../src/world.js"

/**
 * A store update is an install over the top, not a fresh one: the data
 * directory stays and the existing database is reopened. `device-identity`
 * covers the wipe (uninstall, then install); this covers the upgrade, which is
 * the one that ships to everybody at once — a database the new build cannot
 * open costs every user their queue and their history on the same morning.
 */
describe("an upgrade over the top", () => {
  const { app, install, journeys, screens } = world()
  let queued: string

  before(async () => {
    await journeys.startFresh()
    queued = await journeys.queueFirstTrack()
    await screens.tabs.go("home")
    expect(await screens.queue.isEmpty()).toBe(false)

    // `adb install -r` — the same package over the same data directory.
    await app.forceStop()
    await install.install()
    await app.launch()
  })

  it("comes back as the established user, not to onboarding", async () => {
    await screens.tabs.waitUntilVisible()
    expect(await screens.onboarding.isVisible()).toBe(false)
  })

  it("still holds the queue the previous build wrote", async () => {
    await screens.tabs.go("home")
    expect(await screens.queue.isEmpty()).toBe(false)
    expect(queued).not.toBe("")
  })
})
