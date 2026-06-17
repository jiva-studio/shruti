import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows } from "../support/nav.js"

// Booted in Russian: the fixture's topics only hold Russian lectures, so an
// English library would (correctly) leave the topic page empty — see
// topic-language.spec for that language-filtering coverage. This spec just
// checks the tile → topic-page navigation, so it boots a locale whose library
// has lectures for every topic.
test("library · opening a topic shows its lectures", { tag: ["@offline", "@library"] }, async ({ page }) => {
  await boot(page, "ru")
  await gotoTab(page, "search")

  // The discovery page has a grid of topic tiles; tap the first one.
  const tile = page.locator(".tile-grid > *").first()
  await tile.waitFor({ state: "visible", timeout: 20_000 })
  await tile.click()

  await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
  await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
})
