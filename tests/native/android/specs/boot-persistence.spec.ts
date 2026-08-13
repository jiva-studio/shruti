import { AppState } from "../src/ports/AppLifecycle.js"
import { world } from "../src/world.js"

/** Android drops every alarm when the device restarts, so a reminder set on
 *  Monday only survives to Tuesday if something re-arms it at BOOT_COMPLETED —
 *  without the user ever opening the app. */
describe("reminders across a reboot", function () {
  // A reboot outlasts the suite-wide mocha timeout.
  this.timeout(420_000)

  const { app, machine, permissions, notifications, journeys } = world()

  const HALF_WINDOW = 7

  before(async () => {
    await permissions.grant("POST_NOTIFICATIONS")
    await journeys.startWithDailyWisdom("morning")
    await app.sendToBackground(3)
    await notifications.waitUntilArmed(HALF_WINDOW)
    // Home, not force-stop: a stopped app gets no BOOT_COMPLETED, which would
    // make the test pass or fail for a reason of its own making.
    await app.leaveInBackground()
    await machine.reboot()
  })

  it("does not open the app to do it", async () => {
    expect(await app.state()).toBe(AppState.NotRunning)
  })

  it("gives the schedule back to the OS", async () => {
    await notifications.waitUntilArmed(HALF_WINDOW, 120_000)
  })
})
