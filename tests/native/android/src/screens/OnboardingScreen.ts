import { Screen } from "./Screen.js"

export class OnboardingScreen extends Screen {
  private get primary() {
    return $("[data-testid='onboarding-primary']")
  }

  private get skipButton() {
    return $("[data-testid='onboarding-skip']")
  }

  async waitUntilVisible(timeoutMs = 90_000): Promise<void> {
    await this.open()
    await (await this.primary).waitForDisplayed({ timeout: timeoutMs })
  }

  async isVisible(): Promise<boolean> {
    await this.open()
    return (await this.primary).isDisplayed()
  }

  async skip(): Promise<void> {
    await this.open()
    const skip = await this.skipButton
    await skip.waitForDisplayed({ timeout: 90_000 })
    await skip.click()
  }
}
