import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { openLibrary, trackRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The shape of a track row: the title on a line of its own, the speaker under
 * it, then the metadata — reference · date · duration · location.
 *
 * The reference stays off the title line, where a chip makes long titles
 * unreadable. Its absence from that line is the load-bearing assertion here:
 * the default layout promotes nothing to the title row (`top: null`), and no
 * other spec checks that.
 */
test(qase(182, caseTitle(182)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "clean" })
  await openLibrary(page)

  const row = trackRows(page).first()

  await step(page, 182, 0, async () => {
    // Three lines, each carrying one kind of thing.
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row.locator(".title")).toHaveCount(1)
    await expect(row.locator(".author")).toHaveCount(1)
    await expect(row.locator(".details")).toHaveCount(1)
  })

  await step(page, 182, 1, async () => {
    // The metadata line carries the reference and separates its fields.
    const details = row.locator(".details")
    await expect(details.locator(".reference").first()).toBeVisible()
    expect(await details.locator(".sep").count()).toBeGreaterThan(0)
  })

  await step(page, 182, 2, async () => {
    // And the title line carries the title, nothing else.
    await expect(row.locator(".title-block .reference")).toHaveCount(0)
  })
})
