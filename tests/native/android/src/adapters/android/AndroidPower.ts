import type { Power } from "../../ports/Power.js"
import type { Adb } from "./Adb.js"

export class AndroidPower implements Power {
  constructor(private readonly adb: Adb) {}

  async unplug(): Promise<void> {
    this.adb.shell("dumpsys battery unplug")
  }

  async resetBattery(): Promise<void> {
    this.adb.shell("dumpsys battery reset")
  }

  async forceDoze(): Promise<void> {
    this.adb.shell("dumpsys deviceidle enable")
    this.adb.shell("dumpsys deviceidle force-idle")
  }

  async wake(): Promise<void> {
    this.adb.shell("dumpsys deviceidle unforce")
    this.adb.shell("dumpsys deviceidle disable")
  }
}
