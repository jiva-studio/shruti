import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { openTranscript, selectTranscriptText, selectionAction } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test(
  qase(61, caseTitle(61)),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)
    await openTranscript(page)

    await step(page, 61, 0, async () => {
      await selectTranscriptText(page)
    })

    await step(page, 61, 1, async () => {
      await selectionAction(page, "copy").click()

      const clip = await page.evaluate(() => navigator.clipboard.readText())
      expect(clip.trim().length).toBeGreaterThan(0)
    })
  }
)
