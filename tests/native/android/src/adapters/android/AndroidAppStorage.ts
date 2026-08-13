import type { AppStorage } from "../../ports/AppStorage.js"
import type { Adb } from "./Adb.js"

export class AndroidAppStorage implements AppStorage {
  constructor(private readonly adb: Adb) {}

  async audioFiles(): Promise<string[]> {
    const out = this.adb.shell(
      `run-as ${this.adb.appPackage} find . -type f \\( -name '*.mp3' -o -name '*.m4a' -o -name '*.ogg' \\) 2>/dev/null`,
    )
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async bytesUsed(): Promise<number> {
    const out = this.adb.shell(`run-as ${this.adb.appPackage} du -s . 2>/dev/null`)
    return Number(out.trim().split(/\s+/)[0] ?? 0)
  }
}
