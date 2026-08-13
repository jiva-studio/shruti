import { AppState, type AppLifecycle } from "../../ports/AppLifecycle.js"
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

  async taskCount(): Promise<number> {
    const dump = this.adb.shell("dumpsys activity activities")
    // The dump repeats a task across sections; count distinct task ids.
    const tasks = new RegExp(`Task\\{[0-9a-f]+ #(\\d+)[^}]*A=\\d+:${this.adb.appPackage}`, "g")
    const ids = new Set<string>()
    for (const m of dump.matchAll(tasks)) ids.add(m[1]!)
    return ids.size
  }

  async measureColdStart(): Promise<{ totalMs: number }> {
    await this.detach()
    const out = this.adb.shell(`am start -W -n ${this.adb.component}`)
    return { totalMs: Number(out.match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN) }
  }
}
