import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * #1886 — the share slot is app-wide and single, and the Studio held it
 * silently.
 *
 * A cold video render polls for up to eight minutes, and the page keeps
 * running through it because IonRouterOutlet never unmounts it. Walking away
 * therefore left a job with no on-screen trace at all, while every other share
 * surface refused with "Another share is already in progress". The eight
 * minutes are not the defect — cold renders really are that slow — the
 * invisibility was.
 *
 * Determinism comes from a gate, not from timing: the renderer accepts the job
 * and the MP4 never appears, so the render is guaranteed to still be running
 * when the user leaves.
 */
const TAB_SPINNER = ".notes-tab-spinner"

test(qase(550, caseTitle(550)), { tag: ["@offline", "@notes"] }, async ({ page }) => {
  await boot(page, "en", { pro: true })

  await page.route("**/share/video/reels", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ video_id: "e2e-video", url: "", ready: false }),
    })
  )
  await page.route("**/public/share/video/*.mp4", (route) => route.fulfill({ status: 404, body: "" }))

  await step(page, 550, 0, async () => {
    await gotoTab(page, "notes")
    await page.locator(".note[role=button]").first().click()
    await page.getByRole("button", { name: /^share$/i }).first().click()
    await page.getByRole("button", { name: /share video/i }).click()

    await expect(page.locator("ion-textarea.editor")).toBeVisible({ timeout: 30_000 })
  })

  await step(page, 550, 1, async () => {
    await page.getByRole("button", { name: /^download$/i }).click()

    // The render is under way and the user is watching it — nothing to
    // announce elsewhere yet.
    await expect(page.locator("ion-textarea.editor")).toBeVisible()
    await expect(page.locator(TAB_SPINNER)).toBeHidden()
  })

  await step(page, 550, 2, async () => {
    await gotoTab(page, "notes")

    // The job outlived the page that started it; the tab bar now says so.
    await expect(page.locator(TAB_SPINNER)).toBeVisible({ timeout: 30_000 })
  })
})
