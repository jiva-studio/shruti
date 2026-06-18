import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

test(qase([93, 94], "Open chat history and search sessions"), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "chat")

  await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()

  // The seeded demo session ("What is the soul?") shows up in the history list.
  await expect(page.getByText(/soul|душа/i).first()).toBeVisible({ timeout: 10_000 })
})
