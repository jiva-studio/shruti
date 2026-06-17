import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

test("chat · deleting a conversation from history", { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page)
  await gotoTab(page, "chat")
  await page.locator('.chat-page .action-btn[aria-label="Chat history"]').click()

  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  await expect(modal).toBeVisible({ timeout: 10_000 })

  const sessions = modal.locator("ion-item-sliding")
  await expect(sessions.first()).toBeVisible({ timeout: 10_000 })
  const before = await sessions.count()
  expect(before).toBeGreaterThan(0)

  // Swipe the first conversation open and tap its delete (danger) option.
  await sessions
    .first()
    .evaluate((el: HTMLElement & { open(side?: string): Promise<void> }) => el.open("end"))
  await modal.locator('ion-item-option[color="danger"]').first().click()

  await expect.poll(() => modal.locator("ion-item-sliding").count(), { timeout: 10_000 }).toBe(
    before - 1
  )
})
