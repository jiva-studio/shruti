import type { Memory } from "../../ports/Memory.js"
import type { Adb } from "./Adb.js"

export class AndroidMemory implements Memory {
  constructor(private readonly adb: Adb) {}

  async totalPssKb(): Promise<number> {
    const dump = this.adb.shell(`dumpsys meminfo ${this.adb.appPackage}`)
    return Number(dump.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? dump.match(/TOTAL\s+(\d+)/)?.[1] ?? 0)
  }
}
