import type { SystemChooser } from "../../ports/SystemChooser.js"
import type { Adb } from "./Adb.js"

// The share sheet is an activity of its own: `com.android.intentresolver` on
// API 34+, the in-framework Resolver/Chooser on older releases.
const CHOOSER = /com\.android\.intentresolver|ResolverActivity|ChooserActivity/
const RESUMED = /(?:topResumedActivity=|ResumedActivity:\s+)ActivityRecord\{\S+\s+u\d+\s+(\S+)/g
const CHOOSER_INTENT = /act=android\.intent\.action\.CHOOSER[^\n]*?flg=0x([0-9a-f]+)/g
const CONTENT_URI = /content:\/\/[^\s}\]]+/g
const FLAG_GRANT_READ_URI_PERMISSION = 0x1

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

  /**
   * `Intent.createChooser` copies the grant flag off the wrapped send intent
   * only together with the stream's ClipData, so the bit on the chooser record
   * is proof that a file was attached to it.
   */
  async grantsReadAccess(): Promise<boolean> {
    const dump = this.adb.shell("dumpsys activity activities")
    return [...dump.matchAll(CHOOSER_INTENT)].some(
      (match) => (parseInt(match[1]!, 16) & FLAG_GRANT_READ_URI_PERMISSION) !== 0,
    )
  }

  /** Grants live only as long as the activity holding them, so read while the chooser is up. */
  async sharedUris(): Promise<string[]> {
    const dump = this.adb.shell("dumpsys activity permissions")
    const prefix = `content://${this.adb.appPackage}.fileprovider/`
    return [...new Set([...dump.matchAll(CONTENT_URI)].map((match) => match[0]))].filter((uri) =>
      uri.startsWith(prefix),
    )
  }

  /** Every activity the system currently reports as resumed — one per display. */
  private resumed(): string[] {
    const dump = this.adb.shell("dumpsys activity activities")
    return [...new Set([...dump.matchAll(RESUMED)].map((match) => match[1]!))]
  }
}
