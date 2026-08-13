import type { SystemEvents } from "../../ports/SystemEvents.js"
import type { Adb } from "./Adb.js"

export class AndroidSystemEvents implements SystemEvents {
  constructor(private readonly adb: Adb) {}

  async broadcast(action: string): Promise<void> {
    this.adb.shell(`am broadcast -a ${action}`)
  }

  async scheduledAlarms(): Promise<number> {
    return this.adb
      .shell("dumpsys alarm")
      .split("\n")
      .filter((line) => line.includes(this.adb.appPackage)).length
  }
}
