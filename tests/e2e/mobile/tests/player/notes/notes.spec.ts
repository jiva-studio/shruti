import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test(qase(3, caseTitle(3)), { tag: ["@offline", "@notes"] }, async ({ page }) => {
  await boot(page)

  await step(page, 3, 0, async () => {
    await gotoTab(page, "notes")

    // The seeded user has 4 notes on the demo transcript.
    const notes = page.locator("ion-item.note")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    expect(await notes.count()).toBeGreaterThan(0)

    // Each note renders its excerpt text (the shared ExcerptCard body).
    await expect(notes.first()).not.toHaveText("")
  })
})
