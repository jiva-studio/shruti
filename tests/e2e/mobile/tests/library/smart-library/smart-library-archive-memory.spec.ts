import { test, expect, type Locator, type Page } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The master switch turns archiving off with it — it deletes files, so it must
 * not run behind a feature Settings reports as off (#1624). What it must NOT do
 * is forget the schedule: switching back on used to come back on "Never",
 * because the off branch had already overwritten the stored value (#1663).
 *
 * The distinction the memory has to preserve is that "Never" is itself an
 * answer (case 183), so the second half of this case picks it deliberately and
 * expects it to survive rather than be replaced by the earlier choice.
 */
async function openDialog(page: Page): Promise<Locator> {
  const banner = page.locator(".library-banner", { has: page.locator('img[src*="smart-bg"]') })
  await banner.scrollIntoViewIfNeeded()
  await banner.click()
  const dialog = page.locator("ion-modal.smart-library-dialog")
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

const schedule = (d: Locator, label: string) =>
  d.locator("ion-radio", { hasText: new RegExp(`^${label}$`) }).first()

test(qase(195, caseTitle(195)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "en", { pro: true, userDb: "clean" })
  await gotoTab(page, "search")

  let dialog!: Locator
  let enable!: Locator

  await step(page, 195, 0, async (capture) => {
    dialog = await openDialog(page)
    enable = dialog.locator("ion-toggle").first()
    if ((await enable.getAttribute("aria-checked")) !== "true") await enable.click()
    await schedule(dialog, "After 1 day").click()
    await expect(schedule(dialog, "After 1 day")).toHaveAttribute("aria-checked", "true", {
      timeout: 10_000,
    })
    await capture()
  })

  await step(page, 195, 1, async () => {
    // Off stops the destructive half outright: the live schedule reads "Never".
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", "false", { timeout: 10_000 })
    await expect(schedule(dialog, "Never")).toHaveAttribute("aria-checked", "true", {
      timeout: 10_000,
    })
  })

  await step(page, 195, 2, async () => {
    // On brings the user's own schedule back, not a blank one.
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })
    await expect(schedule(dialog, "After 1 day")).toHaveAttribute("aria-checked", "true", {
      timeout: 10_000,
    })
  })

  await step(page, 195, 3, async () => {
    // An explicit "Never" is an answer of its own — the cycle must not undo it
    // by restoring the schedule chosen before it.
    await schedule(dialog, "Never").click()
    await expect(schedule(dialog, "Never")).toHaveAttribute("aria-checked", "true", {
      timeout: 10_000,
    })
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", "false", { timeout: 10_000 })
    await enable.click()
    await expect(enable).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })

    await expect(schedule(dialog, "Never")).toHaveAttribute("aria-checked", "true", {
      timeout: 10_000,
    })
    await expect(schedule(dialog, "After 1 day")).toHaveAttribute("aria-checked", "false")
  })
})
