import type { Connectivity } from "../../ports/Connectivity.js"
import type { Adb } from "./Adb.js"

export class AndroidConnectivity implements Connectivity {
  constructor(private readonly adb: Adb) {}

  async setAirplaneMode(on: boolean): Promise<void> {
    this.adb.shell(`cmd connectivity airplane-mode ${on ? "enable" : "disable"}`)
  }
}
