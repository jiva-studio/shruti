import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// "Delete every chat session and message? This cannot be undone." — the one
// irreversible action in chat, and the cancel path is the half worth pinning:
// a confirm wired to the wrong button empties the history on a mis-tap.
test(qase(603, caseTitle(603)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await boot(page, "en")
  await gotoTab(page, "chat")

  const historyBtn = page.locator('.chat-page .action-btn[aria-label="Chat history"]')
  const modal = page.locator("ion-modal:not(.overlay-hidden)")
  const sessions = modal.locator("ion-item-sliding")
  const clear = modal.locator('ion-toolbar ion-button[color="danger"]')
  const confirm = page.locator("ion-alert")
  let before = 0

  await step(page, 603, 0, async () => {
    await historyBtn.click()
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await expect(sessions.first()).toBeVisible({ timeout: 10_000 })
    before = await sessions.count()
    expect(before).toBeGreaterThan(0)

    await clear.click()
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    await confirm.locator("button.alert-button", { hasText: "Cancel" }).click()
    await expect(confirm).toBeHidden({ timeout: 10_000 })
    await expect(sessions).toHaveCount(before)
  })

  await step(page, 603, 1, async () => {
    await clear.click()
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    await confirm.locator("button.alert-button", { hasText: "Delete" }).click()

    await expect(page.locator("ion-toast")).toContainText("Chat history cleared", {
      timeout: 20_000,
    })
    await expect(page.locator(".suggestions")).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 603, 2, async () => {
    // The sheet is not dismissed by the clear — it stays open over the
    // emptied list, which is where the user is left.
    await expect(modal).toBeVisible()
    await expect(sessions).toHaveCount(0)
    // ion-button is a custom element, not a form control — Playwright reads
    // the ARIA state, which is what a screen reader reads too.
    await expect(clear).toHaveAttribute("aria-disabled", "true")
  })
})
