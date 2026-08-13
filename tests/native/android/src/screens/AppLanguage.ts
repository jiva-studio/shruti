import { Screen } from "./Screen.js"

export class AppLanguage extends Screen {
  /** The language the UI is rendered in: the app mirrors its i18n locale onto
   *  `<html lang>` so screen readers announce the right one. */
  async code(): Promise<string> {
    await this.open()
    return browser.execute(() => document.documentElement.lang)
  }
}
