import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The notes list lifecycle in one case: the seeded notes are listed with their
// excerpt text, and the same notes are still listed after an app restart (they
// live in the user DB and survive a reload).
test(qase(3, caseTitle(3)), { tag: ["@offline", "@notes"] }, async ({ page }) => {
  await boot(page)

  let before = 0

  await step(page, 3, 0, async () => {
    await gotoTab(page, "notes")

    // The seeded user has notes on the demo transcript.
    const notes = page.locator("ion-item.note")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    before = await notes.count()
    expect(before).toBeGreaterThan(0)

    // Each note renders its excerpt text (the shared ExcerptCard body).
    await expect(notes.first()).not.toHaveText("")
  })

  await step(page, 3, 1, async () => {
    // "Restart" the app — the seeded notes are still listed.
    await page.reload()
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    await gotoTab(page, "notes")

    await expect.poll(() => page.locator("ion-item.note").count(), { timeout: 15_000 }).toBe(before)
  })
})
