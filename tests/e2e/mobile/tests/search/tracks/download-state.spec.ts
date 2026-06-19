import { test, expect } from "../../../support/test.js"
import type { Locator } from "@playwright/test"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

// Adding a track moves its discovery-row state to a downloaded ("added") icon —
// the observable terminal of the download (the live 0–100% radial isn't exposed
// in the DOM, so we assert the state transition).
test(
  qase(30, caseTitle(30)),
  { tag: ["@offline", "@search"] },
  async ({ page }) => {
    await boot(page)

    let picked: Locator
    await step(page, 30, 0, async () => {
      await expect(playlistRows(page).first()).toBeVisible({ timeout: 20_000 })
      const queued = (await playlistRows(page).allInnerTexts()).map((t) => t.trim())

      await openLibrary(page)
      const rows = trackRows(page)
      const n = await rows.count()
      let pick = -1
      for (let i = 0; i < n; i++) {
        const text = (await rows.nth(i).innerText()).trim()
        if (!queued.includes(text)) {
          pick = i
          break
        }
      }
      expect(pick).toBeGreaterThanOrEqual(0)
      picked = rows.nth(pick)

      await openTrackSheet(page, picked)
      await trackSheet(page).locator(".add-btn").click()
      await expect(trackSheet(page)).toBeHidden()
    })

    await step(page, 30, 1, async () => {
      // The row now reflects the download (added / downloading / completed icon).
      await expect(picked.locator('[data-testid="track-state"]')).toHaveAttribute(
        "data-state",
        /added|downloading|completed/,
        { timeout: 15_000 }
      )
    })
  }
)
