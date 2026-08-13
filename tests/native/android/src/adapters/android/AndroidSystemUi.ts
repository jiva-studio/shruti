import type { Orientation, SystemUi } from "../../ports/SystemUi.js"
import type { Adb } from "./Adb.js"
import type { WebView } from "./WebView.js"

const KEYCODE_BACK = 4
const KEYCODE_MEDIA_PLAY_PAUSE = 85

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

  async isKeyboardShown(): Promise<boolean> {
    return /mInputShown=true/.test(this.adb.shell("dumpsys input_method"))
  }

  async setNightMode(on: boolean): Promise<void> {
    this.adb.shell(`cmd uimode night ${on ? "yes" : "no"}`)
  }
}
