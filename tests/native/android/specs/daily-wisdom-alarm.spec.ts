import { world } from "../src/world.js"

/** The daily reminder is a promise the app cannot keep on its own: it is closed
 *  when the time comes, so the schedule has to sit with the OS. */
describe("daily wisdom reminder", () => {
  const { app, permissions, notifications, journeys } = world()

  /** The app arms a rolling fortnight of daily pushes. Half of it is far more
   *  than any other engagement push could produce — one per day is the cap. */
  const HALF_WINDOW = 7

  let armedBeforeOptIn = 0

  before(async () => {
    await permissions.grant("POST_NOTIFICATIONS")
    armedBeforeOptIn = await notifications.pendingAlarms()
    await journeys.startWithDailyWisdom("morning")
  })

  it("arms nothing until the user asks for it", () => {
    expect(armedBeforeOptIn).toBe(0)
  })

  it("hands the schedule to the OS", async () => {
    // The app re-arms its pushes on every foreground/background flip; without
    // one, a fresh install sits out the half-hour tick.
    await app.sendToBackground(3)
    await notifications.waitUntilArmed(HALF_WINDOW)
  })
})
