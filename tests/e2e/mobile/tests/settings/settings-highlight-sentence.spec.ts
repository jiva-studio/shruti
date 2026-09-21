import type { Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, openTranscript, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// The setting reaches the transcript through four components. Persisting it is
// not the behaviour — following the audio is, and its absence has to leave the
// reader working rather than inert.

const dialog = (page: Page) => page.locator("ion-modal.transcript-dialog")
const sentences = (page: Page) => page.locator(".transcript-text [data-time-start]")
const marked = (page: Page) => page.locator(".transcript-text [data-time-start].current")

async function closeTranscript(page: Page): Promise<void> {
  await dialog(page).locator(".close-button").click()
  await expect(dialog(page)).toBeHidden({ timeout: 10_000 })
}

async function flip(page: Page, to: "true" | "false"): Promise<void> {
  await gotoTab(page, "settings")
  const toggle = settingToggle(page, "Highlight sentence")
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  if ((await toggle.getAttribute("aria-checked")) !== to) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", to)
}

/** Tap a sentence well into the transcript and hand back its start time. */
async function tapASentence(page: Page): Promise<string> {
  const blocks = sentences(page)
  await expect(blocks.first()).toBeVisible({ timeout: 20_000 })
  const target = blocks.nth(Math.min((await blocks.count()) - 1, 6))
  await target.scrollIntoViewIfNeeded()
  await target.click()
  return (await target.getAttribute("data-time-start")) ?? ""
}

test(qase(605, caseTitle(605)), { tag: ["@offline", "@settings", "@transcript"] }, async ({
  page,
}) => {
  await boot(page)

  await step(page, 605, 0, async () => {
    await openTranscript(page)
    const start = await tapASentence(page)
    await expect(marked(page).first()).toHaveAttribute("data-time-start", start, {
      timeout: 10_000,
    })
    await closeTranscript(page)
  })

  await step(page, 605, 1, async () => {
    await flip(page, "false")
    await gotoTab(page, "home")
    await page.locator(".player").click()
    await expect(dialog(page)).toBeVisible({ timeout: 20_000 })

    const start = await tapASentence(page)
    expect(start).not.toBe("")
    await expect(sentences(page).first()).toBeVisible()
    await expect(marked(page)).toHaveCount(0)
    await closeTranscript(page)
  })

  await step(page, 605, 2, async () => {
    await flip(page, "true")
    await gotoTab(page, "home")
    await page.locator(".player").click()
    await expect(dialog(page)).toBeVisible({ timeout: 20_000 })
    await tapASentence(page)
    await expect(marked(page).first()).toBeAttached({ timeout: 10_000 })
  })
})
