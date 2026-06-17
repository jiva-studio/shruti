import { test, expect } from "../support/test.js"
import { boot } from "../support/bootstrap.js"
import { gotoTab, trackRows, trackTitles, CYRILLIC } from "../support/nav.js"

/**
 * `track_topics` is language-agnostic, so a topic can hold lectures in languages
 * the user hasn't enabled. The topic detail page must list only the lectures
 * available in the library language (PR #973 / #1005): on a Russian library a
 * topic shows its Russian lectures; on an English library a Russian-only topic
 * shows nothing rather than surfacing lectures the user can't consume.
 */

async function openFirstTopic(page: import("@playwright/test").Page): Promise<void> {
  await gotoTab(page, "search")
  const tile = page.locator(".tile-grid > *").first()
  await tile.waitFor({ state: "visible", timeout: 20_000 })
  await tile.click()
  await page.waitForURL("**/search/topic/**", { timeout: 10_000 })
}

test(
  "topic · lists the topic's lectures in the library language",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "ru")
    await openFirstTopic(page)

    await expect(trackRows(page).first()).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const titles = await trackTitles(page)
        return titles.length > 0 && titles.every((t) => CYRILLIC.test(t))
      }, { timeout: 15_000 })
      .toBe(true)
  }
)

test(
  "topic · hides lectures absent from the library language",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    await boot(page, "en")
    await openFirstTopic(page)

    // The fixture's topics only have Russian lectures, so an English library
    // leaves the page empty. The list flashes the unfiltered set before the
    // persisted language filter hydrates, so settle first, then assert it has
    // collapsed to nothing.
    await page.waitForTimeout(2500)
    await expect(trackRows(page)).toHaveCount(0)
  }
)
