import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { openTranscript, selectTranscriptText, selectionAction } from "../support/nav.js"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test(
  qase(61, "Select transcript text with a touch drag to open the popover"),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page)
    await openTranscript(page)
    await selectTranscriptText(page)

    await selectionAction(page, "copy").click()

    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.trim().length).toBeGreaterThan(0)
  }
)
