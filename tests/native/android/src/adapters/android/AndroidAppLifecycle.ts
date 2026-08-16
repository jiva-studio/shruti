import { AppState, type AppLifecycle, type RunningService } from "../../ports/AppLifecycle.js"
import type { Adb } from "./Adb.js"
import type { WebView } from "./WebView.js"

export class AndroidAppLifecycle implements AppLifecycle {
  constructor(
    private readonly adb: Adb,
    private readonly webView: WebView,
  ) {}

  /** Killing the app tears down its WebView; a command left pointing there fails. */
  private async detach(): Promise<void> {
    try {
      await this.webView.leave()
    } catch {
      // already native, or no context to leave
    }
  }

  async currentActivity(): Promise<string> {
    return browser.getCurrentActivity()
  }

  async state(): Promise<AppState> {
    return (await browser.queryAppState(this.adb.appPackage)) as AppState
  }

  async launch(): Promise<void> {
    this.adb.shell(`am start -n ${this.adb.component}`)
  }

  async forceStop(): Promise<void> {
    await this.detach()
    this.adb.shell(`am force-stop ${this.adb.appPackage}`)
  }

  async restart(): Promise<void> {
    await this.forceStop()
    await this.launch()
  }

  async sendToBackground(seconds: number): Promise<void> {
    await browser.background(seconds)
  }

  async leaveInBackground(): Promise<void> {
    await this.detach()
    this.adb.shell("input keyevent KEYCODE_HOME")
  }

  async returnToForeground(): Promise<void> {
    await this.launch()
  }

  async killWhileBackgrounded(): Promise<void> {
    await this.leaveInBackground()
    this.adb.shell(`am kill ${this.adb.appPackage}`)
  }

  /**
   * Overview, then a fling on the app's card. No `am` or `cmd activity` verb
   * removes a task — below the launcher there is nothing to call — so the
   * gesture is the only path that reaches `Service.onTaskRemoved`.
   */
  async removeFromRecents(): Promise<void> {
    await this.detach()
    this.adb.shell("input keyevent KEYCODE_APP_SWITCH")
    await browser.pause(2_000)
    const { width, height } = await browser.getWindowRect()
    const card = {
      left: Math.round(width * 0.15),
      top: Math.round(height * 0.2),
      width: Math.round(width * 0.7),
      height: Math.round(height * 0.5),
      direction: "up",
      percent: 1,
      speed: 6_000,
    }
    for (let attempt = 0; attempt < 3 && (await this.taskCount()) > 0; attempt++) {
      await browser.execute("mobile: swipeGesture", card)
      await browser.pause(1_500)
    }
    this.adb.shell("input keyevent KEYCODE_HOME")
  }

  async taskCount(): Promise<number> {
    const dump = this.adb.shell("dumpsys activity activities")
    // The dump repeats a task across sections; count distinct task ids.
    const tasks = new RegExp(`Task\\{[0-9a-f]+ #(\\d+)[^}]*A=\\d+:${this.adb.appPackage}`, "g")
    const ids = new Set<string>()
    for (const m of dump.matchAll(tasks)) ids.add(m[1]!)
    return ids.size
  }

  async runningServices(): Promise<RunningService[]> {
    const dump = this.adb.shell(`dumpsys activity services ${this.adb.appPackage}`)
    // Header: `<hash> u0 <package>/<class> c:<callingPackage>` — the calling
    // package rides inside the same braces, and is not part of the name.
    const byName = new Map<string, boolean>()
    for (const record of dump.split(/^\s*\* ServiceRecord\{/m).slice(1)) {
      const name = record.match(/^\S+ u\d+ ([^\s}]+)/)?.[1]
      if (!name) continue
      byName.set(name, (byName.get(name) ?? false) || /isForeground=true/.test(record))
    }
    return [...byName].map(([name, foreground]) => ({ name, foreground }))
  }

  async measureColdStart(): Promise<{ totalMs: number }> {
    await this.detach()
    const out = this.adb.shell(`am start -W -n ${this.adb.component}`)
    return { totalMs: Number(out.match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN) }
  }
}
