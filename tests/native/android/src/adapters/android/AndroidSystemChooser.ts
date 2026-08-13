import type { SystemChooser } from "../../ports/SystemChooser.js"
import type { Adb } from "./Adb.js"

// The share sheet is an activity of its own: `com.android.intentresolver` on
// API 34+, the in-framework Resolver/Chooser on older releases.
const CHOOSER = /com\.android\.intentresolver|ResolverActivity|ChooserActivity/
const RESUMED = /(?:topResumedActivity=|ResumedActivity:\s+)ActivityRecord\{\S+\s+u\d+\s+(\S+)/g

export class AndroidSystemChooser implements SystemChooser {
  constructor(private readonly adb: Adb) {}

  async isOpen(): Promise<boolean> {
    return this.resumed().some((activity) => CHOOSER.test(activity))
  }

  async waitUntilOpen(timeoutMs = 30_000): Promise<void> {
    await browser.waitUntil(() => this.isOpen(), {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: `no chooser on top, resumed: ${this.resumed().join(", ") || "nothing"}`,
    })
  }

  async waitUntilClosed(timeoutMs = 30_000): Promise<void> {
    await browser.waitUntil(async () => !(await this.isOpen()), {
      timeout: timeoutMs,
      interval: 1_000,
      timeoutMsg: "the chooser stayed on top",
    })
  }

  /** Every activity the system currently reports as resumed — one per display. */
  private resumed(): string[] {
    const dump = this.adb.shell("dumpsys activity activities")
    return [...new Set([...dump.matchAll(RESUMED)].map((match) => match[1]!))]
  }
}
