import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The note card's attribution line (ExcerptCard's `.meta`, "reference · date")
 * used to print `track.date` verbatim, so the same lecture read `15.03.1996` on
 * a track row and `1996-03-15` on a note saved from it. `formatTrackDate` runs
 * in the hosts now; the card itself stays dumb.
 *
 * Lectures that carry only a year pass through unchanged by design, so the
 * shape assertion applies only to lines that actually show a day and a month.
 */
const ISO_DATE = /\d{4}-\d{2}-\d{2}/
/** `D Mon YYYY` — the `en` form `formatTrackDate` produces. */
const LOCALIZED_DATE = /\b\d{1,2} [A-Za-zÀ-ÿ]{3,} \d{4}\b/

test(qase(420, caseTitle(420)), { tag: ["@offline", "@notes"] }, async ({ page }) => {
  await boot(page)

  let metas: string[] = []

  await step(page, 420, 0, async () => {
    await gotoTab(page, "notes")
    const notes = page.locator(".note[role=button]")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    expect(await notes.count()).toBeGreaterThan(0)
    metas = await page.locator(".note[role=button] .meta").allInnerTexts()
  })

  await step(page, 420, 1, async () => {
    for (const meta of metas) {
      expect(meta, `raw ISO date on a note card: "${meta}"`).not.toMatch(ISO_DATE)
      // A full date renders as `D Mon YYYY`; a year-only lecture renders the
      // bare year and is left alone.
      if (/\d{1,2}\s+\S+\s+\d{4}/.test(meta)) expect(meta).toMatch(LOCALIZED_DATE)
    }
  })
})
