import type { AnonymousMint } from "../src/ports/Backend.js"
import { world } from "../src/world.js"

/**
 * `Device.getId()` is ANDROID_ID, which an uninstall does not reset — and that
 * is why a "fresh" install used to come back carrying the previous run's
 * server-side data. The behaviour is deliberate (it is what keeps an anonymous
 * user their history across a reinstall), so it is pinned here: the app
 * presents the same device to the server both times, and the server hands it
 * back the same anonymous user.
 *
 * The identity is observed through the mock's record of `/auth/anonymous` —
 * the one place the device id crosses the bridge.
 */
describe("device identity survives a reinstall", () => {
  const { app, install, backend, screens } = world()
  let first: AnonymousMint
  let second: AnonymousMint

  /** Uninstall, install again, launch — and wait for the identity the fresh
   *  install asks the server for. */
  async function reinstallAndMint(): Promise<AnonymousMint> {
    const before = (await backend.anonymousMints()).length
    await app.forceStop()
    await install.uninstall()
    expect(await install.isInstalled()).toBe(false)
    await install.install()
    await app.launch()
    await screens.onboarding.waitUntilVisible()
    await browser.waitUntil(async () => (await backend.anonymousMints()).length > before, {
      timeout: 60_000,
      interval: 2_000,
      timeoutMsg: "the reinstalled app never asked for an anonymous identity",
    })
    const mints = await backend.anonymousMints()
    return mints[mints.length - 1]!
  }

  before(async () => {
    await backend.reset()
    first = await reinstallAndMint()
  })

  it("presents a device id on a fresh install", () => {
    expect(first.deviceId).not.toBe("")
    expect(first.platform).toBe("android")
  })

  describe("after uninstalling and installing again", () => {
    before(async () => {
      second = await reinstallAndMint()
    })

    it("asks for an identity again — the install really was wiped", async () => {
      expect((await backend.anonymousMints()).length).toBeGreaterThanOrEqual(2)
    })

    it("presents the same device", () => {
      expect(second.deviceId).toBe(first.deviceId)
    })

    it("comes back as the same anonymous user", () => {
      expect(second.userId).toBe(first.userId)
    })
  })
})
