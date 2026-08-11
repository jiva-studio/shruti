import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import type { Page } from "@playwright/test"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab, openTranscript, transcriptSentencePoints } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * What the drag highlighted is what gets saved (issue #1732).
 *
 * While dragging, each branch emitted a range built from the FIXED anchor while
 * the release emitted the running pair, so a drag that went past the anchor one
 * way and then back past it the other collapsed the highlight while the far
 * edge stayed extended — the note (and the "Ask Sadhu" text, and the share
 * payload) then covered a span that was never shown as selected.
 *
 * The two are compared through the DOM: the live selection paints `.selected`,
 * the saved note paints `.highlighted`, over the same spans.
 */

/** Distinct `start-end` ranges carrying `className` (each sentence renders as
 *  two nested elements that both carry the block's time attributes). */
function rangesWith(page: Page, className: string): Promise<string[]> {
  return page
    .locator(`.transcript-text .${className}`)
    .evaluateAll((els) => [
      ...new Set(
        els.map((e) => `${e.getAttribute("data-time-start")}-${e.getAttribute("data-time-end")}`)
      ),
    ])
}

test(qase(236, caseTitle(236)), { tag: ["@offline", "@transcript"] }, async ({ page }) => {
  await boot(page, "en", { userDb: "single" })

  let highlightedAtRelease: string[] = []

  await step(page, 236, 0, async () => {
    await gotoTab(page, "home")
    await openTranscript(page)

    const points = await transcriptSentencePoints(page)
    expect(points.length, "need a sentence before and after the anchor").toBeGreaterThanOrEqual(3)
    const [before, anchor, after] = points

    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: anchor.x, y: anchor.y }],
    })
    await page.waitForTimeout(650) // long-press threshold
    // Down past the anchor's end…
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: after.x, y: after.y }],
    })
    await page.waitForTimeout(250)
    // …then back up past its start, which is where the two ranges diverged.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: before.x, y: before.y }],
    })
    await page.waitForTimeout(250)

    // Read the live highlight BEFORE releasing — this is what the user agreed to.
    highlightedAtRelease = await rangesWith(page, "selected")
    expect(highlightedAtRelease.length).toBeGreaterThan(0)

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect(page.locator(".selection-actions").first()).toBeVisible({ timeout: 10_000 })
    // copy=0, bookmark=1, share=2, ask=3.
    await page.locator(".selection-actions ion-button").nth(1).click()
    await expect(page.locator(".selection-actions")).toBeHidden({ timeout: 10_000 })
  })

  await step(page, 236, 1, async () => {
    await expect
      .poll(() => rangesWith(page, "highlighted"), { timeout: 10_000 })
      .toEqual(highlightedAtRelease)
  })
})
