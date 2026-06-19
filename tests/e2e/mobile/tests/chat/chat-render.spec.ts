import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Sending a message needs the chat backend — that's a @live test. Here we only
// assert the chat surface renders and is ready for input (no network).
test(qase(84, caseTitle(84)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "chat")

  await step(page, 84, 0, async () => {
    await expect(page.locator(".chat-page")).toBeVisible({ timeout: 20_000 })

    const input = page.locator(".chat-inputbar textarea")
    await expect(input).toBeVisible()
    await expect(input).toBeEnabled()

    // Empty state offers starter suggestion chips.
    await expect(page.locator(".suggestions")).toBeVisible()
  })
})
