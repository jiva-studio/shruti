import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase([93, 94], caseTitle(93)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "chat")

  await step(page, 93, 0, async () => {
    await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()

    // The seeded demo session ("What is the soul?") shows up in the history list.
    await expect(page.getByText(/soul|душа/i).first()).toBeVisible({ timeout: 10_000 })
  })
})
