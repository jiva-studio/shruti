import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(96, caseTitle(96)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "chat")

  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  const sessions = modal.locator("ion-item-sliding")
  let before = 0

  await step(page, 96, 0, async () => {
    await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()

    await expect(modal).toBeVisible({ timeout: 10_000 })

    await expect(sessions.first()).toBeVisible({ timeout: 10_000 })
    before = await sessions.count()
    expect(before).toBeGreaterThan(0)
  })

  await step(page, 96, 1, async () => {
    // Swipe the first conversation open and tap its delete (danger) option.
    await sessions
      .first()
      .evaluate((el: HTMLElement & { open(side?: string): Promise<void> }) => el.open("end"))
    await modal.locator('ion-item-option[color="danger"]').first().click()

    await expect.poll(() => modal.locator("ion-item-sliding").count(), { timeout: 10_000 }).toBe(
      before - 1
    )
  })
})
