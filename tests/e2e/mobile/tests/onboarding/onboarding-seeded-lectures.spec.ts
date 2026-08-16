import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { interceptContent, preseedUserDbOnce, preseedNonPro } from "../../support/bootstrap.js"
import { playlistRows } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * The value-moment screen names five lectures; Home has to open on those five
 * and not on another draw (Qase 590, issue #1888).
 *
 * Picks the SECOND curated topic on purpose: the first has no lecture in the
 * fixture's English catalog, so the screen falls back to the beginner
 * collection — deterministic, and the defect cannot show there. The second has
 * a pool of twelve, of which the screen shows a random five, so a second
 * resolve of the same query is a different five.
 */
test(qase(590, caseTitle(590)), { tag: ["@offline", "@onboarding"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedUserDbOnce(page, "en", "clean")
  await preseedNonPro(page)

  const primary = page.getByTestId("onboarding-primary")
  const shownTitles = page.getByTestId("onboarding-lectures").locator("ion-item.track .title")
  let shown: string[] = []

  await step(page, 590, 0, async () => {
    await page.goto("/")
    await expect(primary).toBeVisible({ timeout: 30_000 })
    await primary.click() // Welcome → Topics
    await page.getByTestId("onboarding-topics").locator("button").nth(1).click()
    await primary.click() // Topics → Daily wisdom — this is the `seed` flip
    await page.getByTestId("onboarding-wisdom-morning").click()
  })

  await step(page, 590, 1, async () => {
    await primary.click() // Daily wisdom → Value moment
    await expect(shownTitles.first()).toBeVisible({ timeout: 20_000 })
    // Read the list only once it stops changing — the reload the flip started
    // may still be in flight, and the promise is about the SETTLED screen.
    let previous = ""
    await expect
      .poll(
        async () => {
          const current = (await shownTitles.allTextContents()).join("|")
          const stable = current !== "" && current === previous
          previous = current
          return stable
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    shown = await shownTitles.allTextContents()
    expect(shown.length).toBeGreaterThan(1)
  })

  await step(page, 590, 2, async () => {
    await primary.click() // Value moment (last page) → finish → Home
    await page.waitForURL("**/tabs/home", { timeout: 30_000 })
    const seeded = playlistRows(page).locator(".title")
    await expect(seeded).toHaveCount(shown.length, { timeout: 20_000 })
    expect((await seeded.allTextContents()).sort()).toEqual([...shown].sort())
  })
})
