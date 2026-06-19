import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

test(qase(117, caseTitle(117)), { tag: ["@offline", "@settings"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "settings")

  await step(page, 117, 0, async () => {
    // "Open transcript automatically" starts OFF in the seeded user.
    const toggle = settingToggle(page, "Open transcript automatically")
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    await expect(toggle).toHaveAttribute("aria-checked", "false")

    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
  })

  await step(page, 117, 1, async () => {
    // End-to-end effect of the setting: starting a track now pops the transcript
    // reader on its own — no tap on the player needed.
    await gotoTab(page, "home")
    await playFirstQueuedTrack(page)
    await expect(page.locator("ion-modal.transcript-dialog")).toBeVisible({ timeout: 20_000 })
  })
})
