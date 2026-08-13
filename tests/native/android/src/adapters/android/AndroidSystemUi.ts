import type { Orientation, SystemUi } from "../../ports/SystemUi.js"
import type { Adb } from "./Adb.js"
import type { WebView } from "./WebView.js"

const KEYCODE_BACK = 4
const KEYCODE_MEDIA_PLAY_PAUSE = 85
const KEYCODE_POWER = 26

export class AndroidSystemUi implements SystemUi {
  constructor(
    private readonly adb: Adb,
    private readonly webView: WebView,
  ) {}

  /** Key events reach the device only from the native context. */
  private async detach(): Promise<void> {
    try {
      await this.webView.leave()
    } catch {
      // already native
    }
  }

  async rotate(to: Orientation): Promise<void> {
    await browser.setOrientation(to)
  }

  async pressBack(): Promise<void> {
    await this.detach()
    await browser.pressKeyCode(KEYCODE_BACK)
  }

  async pressMediaPlayPause(): Promise<void> {
    this.adb.shell(`input keyevent ${KEYCODE_MEDIA_PLAY_PAUSE}`)
  }

  async setScreenOn(on: boolean): Promise<void> {
    if ((await this.isScreenOn()) === on) return
    this.adb.shell(`input keyevent ${KEYCODE_POWER}`)
  }

  async isScreenOn(): Promise<boolean> {
    return /mWakefulness=Awake/.test(this.adb.shell("dumpsys power"))
  }

  async isKeyboardShown(): Promise<boolean> {
    return /mInputShown=true/.test(this.adb.shell("dumpsys input_method"))
  }

  async setNightMode(on: boolean): Promise<void> {
    this.adb.shell(`cmd uimode night ${on ? "yes" : "no"}`)
  }

  async setFontScale(scale: number): Promise<void> {
    this.adb.shell(`settings put system font_scale ${scale}`)
  }
}
