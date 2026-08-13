import type { Stress } from "../../ports/Stress.js"
import type { Adb } from "./Adb.js"

export class AndroidStress implements Stress {
  constructor(private readonly adb: Adb) {}

  async randomEvents(count: number): Promise<void> {
    this.adb.shell(
      `monkey -p ${this.adb.appPackage} --throttle 80 --pct-syskeys 0 --ignore-crashes --ignore-timeouts -s 42 ${count}`,
    )
  }
}
