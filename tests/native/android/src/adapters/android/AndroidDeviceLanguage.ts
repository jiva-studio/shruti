import type { DeviceLanguage } from "../../ports/DeviceLanguage.js"
import type { Adb } from "./Adb.js"

/**
 * LocaleManager's per-app locale (`cmd locale`, API 33+) — what Android's own
 * "App language" screen writes, delivered to the app as a real configuration
 * change.
 *
 * The device-wide locale is deliberately not the lever here: `persist.sys.locale`
 * is only read when the framework boots, so changing it needs root plus a
 * `stop; start`, which takes the Appium session and every other client of the
 * emulator down with it.
 */
export class AndroidDeviceLanguage implements DeviceLanguage {
  constructor(private readonly adb: Adb) {}

  async current(): Promise<string | null> {
    const inside = this.adb.shell(`cmd locale get-app-locales ${this.adb.appPackage}`).match(/\[(.*)\]/)
    return inside?.[1] ? inside[1] : null
  }

  async set(tag: string): Promise<void> {
    this.adb.shell(`cmd locale set-app-locales ${this.adb.appPackage} --locales ${tag}`)
  }

  async clear(): Promise<void> {
    this.adb.shell(`cmd locale set-app-locales ${this.adb.appPackage} --locales ""`)
  }
}
