import { Screen } from "./Screen.js"

/** The reminder times the daily-wisdom page offers. */
export type WisdomPreset = "morning" | "afternoon" | "evening"

/** Upper bound on Continue presses — the flow is a handful of pages. */
const MAX_PAGES = 8

export class OnboardingScreen extends Screen {
  private get primary() {
    return $("[data-testid='onboarding-primary']")
  }

  private get skipButton() {
    return $("[data-testid='onboarding-skip']")
  }

  private chip(preset: WisdomPreset) {
    return $(`[data-testid='onboarding-wisdom-${preset}']`)
  }

  async waitUntilVisible(timeoutMs = 90_000): Promise<void> {
    await this.open()
    await (await this.primary).waitForDisplayed({ timeout: timeoutMs })
  }

  async isVisible(): Promise<boolean> {
    await this.open()
    return (await this.primary).isDisplayed()
  }

  /** The primary call to action, as rendered — localized copy. */
  async primaryLabel(): Promise<string> {
    await this.open()
    const primary = await this.primary
    await primary.waitForDisplayed({ timeout: 90_000 })
    return (await primary.getText()).trim()
  }

  async skip(): Promise<void> {
    await this.open()
    const skip = await this.skipButton
    await skip.waitForDisplayed({ timeout: 90_000 })
    await skip.click()
  }

  /** Walk to the daily-wisdom page and pick a reminder time. */
  async chooseDailyWisdom(preset: WisdomPreset): Promise<void> {
    await this.open()
    await this.advanceUntil(
      async () => (await this.chip(preset)).isDisplayed(),
      `the ${preset} reminder time`,
    )
    await (await this.chip(preset)).click()
    await browser.waitUntil(
      async () => (await (await this.chip(preset)).getAttribute("aria-checked")) === "true",
      { timeout: 15_000, interval: 500, timeoutMsg: `the ${preset} reminder time stayed unpicked` },
    )
  }

  /** Continue to the end of the flow; the last press finishes onboarding. */
  async finish(): Promise<void> {
    await this.open()
    await this.advanceUntil(async () => !(await (await this.primary).isDisplayed()), "the end")
  }

  /** The carousel keeps every slide mounted and only the current one on
   *  screen, so a page is reached by pressing Continue until its content is. */
  private async advanceUntil(reached: () => Promise<boolean>, what: string): Promise<void> {
    await (await this.primary).waitForDisplayed({ timeout: 90_000 })
    for (let page = 0; page < MAX_PAGES; page++) {
      try {
        await browser.waitUntil(reached, { timeout: 5_000, interval: 500 })
        return
      } catch {
        // not this page
      }
      // Continue is gone once the flow ends — keep polling for `reached`
      // instead of waiting on a button that is never coming back.
      const next = await this.primary
      if (await next.isDisplayed()) await next.click()
    }
    throw new Error(`onboarding never reached ${what}`)
  }
}
