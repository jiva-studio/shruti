import { world } from "../src/world.js"

/**
 * The daily reminder is armed while the user is awake and has to fire while
 * the device is not. `daily-wisdom-alarm` proves the OS took the schedule;
 * what only a device can answer is whether it still holds it after the device
 * idles — the state in which the reminder actually has to work.
 */
describe("the daily reminder under Doze", () => {
  const { app, power, permissions, notifications, journeys } = world()

  const HALF_WINDOW = 7

  after(async () => {
    await power.wake()
    await power.resetBattery()
  })

  before(async () => {
    await permissions.grant("POST_NOTIFICATIONS")
    await journeys.startWithDailyWisdom("morning")
    await app.sendToBackground(3)
    await notifications.waitUntilArmed(HALF_WINDOW)
  })

  it("keeps the schedule with the OS once the device goes idle", async () => {
    await app.leaveInBackground()
    await power.unplug()
    await power.forceDoze()
    await browser.pause(10_000)
    expect(await notifications.pendingAlarms()).toBeGreaterThanOrEqual(HALF_WINDOW)
  })
})
