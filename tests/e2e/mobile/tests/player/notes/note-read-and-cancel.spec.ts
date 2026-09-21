import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Case 5 deletes a note; nothing covers the sheet being dismissed. Cancel and
// Delete are adjacent in the same list, so "Cancel deleted it" is a one-line
// mistake with no undo behind it.
test(qase(606, caseTitle(606)), { tag: ["@offline", "@notes"] }, async ({ page }) => {
  await boot(page)

  const notes = page.locator(".note[role=button]")
  const sheet = page.locator("ion-action-sheet")
  let before = 0
  let quoted = ""

  await step(page, 606, 0, async () => {
    await gotoTab(page, "notes")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    before = await notes.count()
    expect(before).toBeGreaterThan(0)

    const first = notes.first()
    quoted = (await first.locator(".excerpt-body").innerText()).trim()
    expect(quoted.length).toBeGreaterThan(0)
    // The lecture it came from, not just a span of milliseconds.
    await expect(first.locator(".meta-block")).not.toHaveText("")
  })

  await step(page, 606, 1, async () => {
    await notes.first().click()
    await expect(sheet).toBeVisible({ timeout: 10_000 })
    await expect(sheet.getByText("Copy text")).toBeVisible()
    await expect(sheet.getByText("Share", { exact: true })).toBeVisible()
    await expect(sheet.locator("button.action-sheet-destructive")).toBeVisible()
  })

  await step(page, 606, 2, async () => {
    await sheet.locator("button.action-sheet-cancel").click()
    await expect(sheet).toBeHidden({ timeout: 10_000 })
    await expect(notes).toHaveCount(before)
    expect((await notes.first().locator(".excerpt-body").innerText()).trim()).toBe(quoted)
  })
})
