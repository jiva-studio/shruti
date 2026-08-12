import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"

/**
 * The plus says so when the submit is refused.
 *
 * A rejected submit writes no job id, so nothing on the tile can change: the
 * badge the other ingest specs watch never appears, and the haptic already
 * fired before the request left. Every visible consequence of the tap is a
 * consequence of SUCCESS — which is why the failure had to be silent until the
 * call site started reading what `addByUrl` returns (#1778). The toast is the
 * only observable there is, and this is the spec that keeps it.
 *
 * Not the paywall lane: case 207 covers `not_pro`, which answers with the
 * subscription page and must NOT also toast. This is a plain server failure.
 */

const FAILURE_COPY = "Couldn't add the lecture. Check your connection and try again."

test(qase(301, caseTitle(301)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  const ingest = await installIngestMock(page, { submitStatus: 503, submitErrorCode: "internal" })
  await boot(page, "en", { pro: true, userDb: "clean" })
  await openLibrary(page)

  const tile = page.locator(".carousel-cell .track-tile").first()
  const toast = page.locator("ion-toast")

  await step(page, 301, 0, async () => {
    await expect(tile).toBeVisible({ timeout: 20_000 })
    await tile.locator("button.add").click()
    await expect(toast).toContainText(FAILURE_COPY, { timeout: 20_000 })
    expect(ingest.submits).toHaveLength(1)
  })

  await step(page, 301, 1, async () => {
    // Still an offer. A tile that lost its plus over a failed submit is a
    // lecture the user can never add.
    await expect(tile.locator("button.add")).toHaveCount(1)
    await expect(tile.locator(".ingest-badge")).toHaveCount(0)
  })

  await step(page, 301, 2, async () => {
    // Clear the screen first, so the assertion below cannot read the toast the
    // first tap left behind.
    await toast.first().evaluate((el: HTMLElement & { dismiss?: () => void }) => el.dismiss?.())
    await expect(toast).toHaveCount(0, { timeout: 20_000 })

    await tile.locator("button.add").click()
    await expect(toast).toContainText(FAILURE_COPY, { timeout: 20_000 })
    expect(ingest.submits).toHaveLength(2)
  })
})
