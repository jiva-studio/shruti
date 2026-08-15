import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"

/**
 * A failed add says which failure it was.
 *
 * One sentence covered every rejection — "check your connection and try again"
 * — so a user whose connection was fine spent the outage toggling Wi-Fi
 * (#1844). The reason now leaves the store with the failure, and this is the
 * spec that keeps the two causes apart: a backend that answered badly, and a
 * request that never reached one.
 *
 * Case 301 is the neighbouring lane — it holds the toast to the tap at all,
 * and that the tile survives as an offer.
 */

const SERVER_COPY = "Couldn't add the lecture — the service is having trouble. Try again later."
const OFFLINE_COPY = "Couldn't add the lecture. Check your connection and try again."

test(qase(361, caseTitle(361)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  await installIngestMock(page, { submitStatus: 503, submitErrorCode: "internal" })
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tile = page.locator(".carousel-cell .track-tile").first()
  const toast = page.locator("ion-toast")

  await step(page, 361, 0, async () => {
    await expect(tile).toBeVisible({ timeout: 20_000 })
    await tile.locator("button.add").click()
    await expect(toast).toContainText(SERVER_COPY, { timeout: 20_000 })
  })

  await step(page, 361, 1, async () => {
    await toast.first().evaluate((el: HTMLElement & { dismiss?: () => void }) => el.dismiss?.())
    await expect(toast).toHaveCount(0, { timeout: 20_000 })

    // Registered after the mock, so this handler wins: the submit now dies on
    // the wire instead of coming back with a status.
    await page.route("**/orchestrator/run", (route) => void route.abort("failed"))

    await tile.locator("button.add").click()
    await expect(toast).toContainText(OFFLINE_COPY, { timeout: 20_000 })
  })
})
