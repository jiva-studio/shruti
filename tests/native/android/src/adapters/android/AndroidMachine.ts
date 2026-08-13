import type { Machine } from "../../ports/Machine.js"
import type { Adb } from "./Adb.js"

export class AndroidMachine implements Machine {
  constructor(private readonly adb: Adb) {}

  async isBooted(): Promise<boolean> {
    try {
      return this.adb.shell("getprop sys.boot_completed").trim() === "1"
    } catch {
      // adbd is gone mid-reboot.
      return false
    }
  }

  async reboot(timeoutMs = 240_000): Promise<void> {
    const tunnels = this.reverseTunnels()
    this.adb.exec("reboot")
    // The old system answers for a beat after the command, so wait for the
    // device to actually go down before believing a "booted" reading.
    await this.waitFor(async () => !(await this.isBooted()), 60_000, "the device never went down")
    await this.waitFor(() => this.isBooted(), timeoutMs, "the device never came back up")
    // `adb reverse` lives in the device's adbd: the reboot drops the tunnel the
    // APK reaches the mock server through, and every later spec needs it.
    for (const [remote, local] of tunnels) this.adb.exec("reverse", remote, local)
    // A fresh boot lands on the keyguard, which would swallow the taps of
    // whatever runs next.
    this.adb.shell("wm dismiss-keyguard")
  }

  /** `<serial> <remote> <local>` per line. */
  private reverseTunnels(): Array<[string, string]> {
    return this.adb
      .exec("reverse", "--list")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 3)
      .map((parts) => [parts[1]!, parts[2]!])
  }

  private async waitFor(
    condition: () => Promise<boolean>,
    timeoutMs: number,
    timeoutMsg: string,
  ): Promise<void> {
    await browser.waitUntil(
      async () => {
        // Appium reaps a session that goes quiet for `newCommandTimeout`, and a
        // reboot outlasts it. `getTimeouts` is answered by the driver itself, so
        // it keeps the session alive without reaching for the offline device.
        await browser.getTimeouts()
        return condition()
      },
      { timeout: timeoutMs, interval: 5_000, timeoutMsg },
    )
  }
}
