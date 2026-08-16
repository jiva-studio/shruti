import type { Logs } from "../../ports/Logs.js"
import type { Adb } from "./Adb.js"

export class AndroidLogs implements Logs {
  constructor(private readonly adb: Adb) {}

  async clear(): Promise<void> {
    this.adb.exec("logcat", "-c")
  }

  async errorLines(): Promise<string[]> {
    return this.adb
      .exec("logcat", "-d", "-b", "main,crash", "*:E")
      .split("\n")
      .filter((line) => /ANR in|FATAL EXCEPTION|AndroidRuntime/.test(line))
      .filter((line) => line.includes(this.adb.appPackage))
  }

  async linesMatching(pattern: RegExp): Promise<string[]> {
    return this.adb
      .exec("logcat", "-d", "-b", "main,crash")
      .split("\n")
      .filter((line) => pattern.test(line))
  }
}
