import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, trackRows, trackSheet, trackTitles } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// The card is a modal over the library: its close control is the only way
// back, and a card that dismissed the list with it would be a dead end.
test(qase(607, caseTitle(607)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page)
  let listed: string[] = []

  await step(page, 607, 0, async () => {
    await openLibrary(page)
    const rows = trackRows(page)
    await expect(rows.first()).toBeVisible({ timeout: 20_000 })
    listed = await trackTitles(page)
    expect(listed.length).toBeGreaterThan(0)

    // Not every lecture in the catalog carries one; find one that does.
    const sheet = trackSheet(page)
    const limit = Math.min(await rows.count(), 5)
    let described = false
    for (let i = 0; i < limit && !described; i++) {
      await openTrackSheet(page, rows.nth(i))
      await expect(sheet.locator(".sheet-title")).not.toHaveText("")
      described = (await sheet.locator(".sheet-body > .description").count()) > 0
      if (!described) {
        await sheet.locator(".close-button").click()
        await expect(sheet).toBeHidden({ timeout: 10_000 })
      }
    }
    expect(described, "no lecture among the first five carries a description").toBe(true)

    await expect(sheet.locator(".sheet-body > .description")).not.toHaveText("")
    // Scoped to the header: the similar-lectures row below carries `.author` too.
    await expect(sheet.locator(".sheet-heading .author")).not.toHaveText("")
  })

  await step(page, 607, 1, async () => {
    await trackSheet(page).locator(".close-button").click()
    await expect(trackSheet(page)).toBeHidden({ timeout: 10_000 })
    await expect(trackRows(page).first()).toBeVisible({ timeout: 10_000 })
    expect(await trackTitles(page)).toEqual(listed)
  })
})
