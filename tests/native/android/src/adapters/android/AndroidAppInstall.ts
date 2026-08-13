import { fileURLToPath } from "node:url"
import type { AppInstall } from "../../ports/AppInstall.js"
import type { Adb } from "./Adb.js"

/** The same APK the runner installs at session start (see wdio.conf.ts). */
export const DEBUG_APK =
  process.env.LECTORIUM_APK ??
  fileURLToPath(
    new URL(
      "../../../../../../modules/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
      import.meta.url,
    ),
  )

export class AndroidAppInstall implements AppInstall {
  constructor(
    private readonly adb: Adb,
    private readonly apk: string = DEBUG_APK,
  ) {}

  async install(): Promise<void> {
    // `-g` mirrors the session's autoGrantPermissions, which only covers the
    // install Appium itself performs.
    this.adb.exec("install", "-r", "-g", this.apk)
  }

  async uninstall(): Promise<void> {
    this.adb.exec("uninstall", this.adb.appPackage)
  }

  async isInstalled(): Promise<boolean> {
    const out = this.adb.shell(`pm list packages ${this.adb.appPackage}`)
    return out.split("\n").some((line) => line.trim() === `package:${this.adb.appPackage}`)
  }
}
