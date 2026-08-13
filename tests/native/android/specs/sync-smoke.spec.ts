import { world } from "../src/world.js"

/**
 * Smoke: sync actually leaves the device over HTTP. Merge rules, conflicts and
 * the outbox are the web suite's business; only a device proves the transport
 * runs at all — and that nothing else escapes to production.
 */
describe("profile sync leaves the device", () => {
  const { backend, journeys } = world()

  before(async () => {
    // The mock records every spec in the run; only this spec's traffic counts.
    await backend.reset()
    await journeys.startFresh()
    await journeys.queueFirstTrack()
  })

  it("pulls and pushes against the backend", async () => {
    await browser.waitUntil(
      async () => {
        const paths = (await backend.requests()).map((r) => r.path)
        return paths.includes("/profile/sync/pull") && paths.includes("/profile/sync/push")
      },
      { timeout: 90_000, interval: 3_000, timeoutMsg: "no sync traffic reached the backend" },
    )
  })

  it("asks for nothing the mock does not serve", async () => {
    const unhandled = [...new Set((await backend.unhandled()).map((r) => `${r.method} ${r.path}`))]
    expect(unhandled).toEqual([])
  })
})
