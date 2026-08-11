import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTranscript, selectOneTranscriptSentence } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import type { Page } from "@playwright/test"

/** The distinct `start-end` ranges carrying a saved-note underline. */
function underlinedRanges(page: Page): Promise<string[]> {
  return page
    .locator(".transcript-text .highlighted")
    .evaluateAll((els) => [
      ...new Set(
        els.map((e) => `${e.getAttribute("data-time-start")}-${e.getAttribute("data-time-end")}`)
      ),
    ])
}

/**
 * A bookmark underlines the sentence it was taken on — and only that one
 * (issue #1731). Sentence blocks in this corpus are commonly contiguous
 * (`end_i === start_{i+1}`; 252 of the 393 adjacent pairs in the e2e fixture),
 * and the saved-note pass used to treat a shared endpoint as an overlap, so a
 * one-sentence bookmark painted the wavy underline across its neighbours too —
 * and bled the note's id onto them, making a tap there offer to delete it.
 *
 * The single-track user.db starts with no notes, so the underline count is a
 * clean 0 → 1.
 */
test(qase(235, caseTitle(235)), { tag: ["@offline", "@transcript"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "single" })

  const highlighted = page.locator(".transcript-text .highlighted")
  let selected = { start: -1, end: -1 }

  await step(page, 235, 0, async () => {
    await gotoTab(page, "home")
    await openTranscript(page)
    await expect(highlighted).toHaveCount(0)

    selected = await selectOneTranscriptSentence(page)
    // copy=0, bookmark=1, share=2, ask=3.
    await page.locator(".selection-actions ion-button").nth(1).click()
    await expect(page.locator(".selection-actions")).toBeHidden({ timeout: 10_000 })
  })

  await step(page, 235, 1, async () => {
    // A sentence renders as two nested spans that both carry the block's
    // attributes (`$attrs` falls through to the root AND is re-bound on the
    // text span), so count distinct time ranges, not elements.
    await expect
      .poll(() => underlinedRanges(page), { timeout: 10_000 })
      .toEqual([`${selected.start}-${selected.end}`])
  })
})
