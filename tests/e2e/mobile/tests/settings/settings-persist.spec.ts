import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Persistence + cross-tab effect of useConfig-backed settings. No existing spec
// reloads the page, so case 152 specifically proves the setting survives a full
// app re-hydration (IndexedDB-backed user.db / Preferences); case 153 covers the
// activity-tracker toggle's cross-tab effect on the Home activity card.

test(
  qase(152, caseTitle(152)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "settings")

    let flipped = ""
    await step(page, 152, 0, async () => {
      // "Open transcript automatically" — record its seeded value, flip it.
      const toggle = settingToggle(page, "Open transcript automatically")
      await expect(toggle).toBeVisible({ timeout: 20_000 })
      const before = await toggle.getAttribute("aria-checked")
      flipped = before === "true" ? "false" : "true"

      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-checked", flipped)
    })

    await step(page, 152, 1, async () => {
      // Full re-hydration: reload the bundle, wait for the tab bar (boot's own
      // ready signal), then re-navigate to settings. The persisted value must
      // come back as the flipped one — not the seeded default.
      await page.reload()
      await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
      await gotoTab(page, "settings")

      const after = settingToggle(page, "Open transcript automatically")
      await expect(after).toBeVisible({ timeout: 20_000 })
      await expect(after).toHaveAttribute("aria-checked", flipped)
    })
  }
)

test(
  qase(153, caseTitle(153)),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en")

    await step(page, 153, 0, async () => {
      // The seeded user has playlist + history, so the activity card shows by
      // default on Home.
      await gotoTab(page, "home")
      const card = page.locator(".activity-card")
      await expect(card).toBeVisible({ timeout: 20_000 })

      // Turn "Activity tracker" off in Settings.
      await gotoTab(page, "settings")
      const toggle = settingToggle(page, "Activity tracker")
      await expect(toggle).toBeVisible({ timeout: 20_000 })
      await expect(toggle).toHaveAttribute("aria-checked", "true")
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-checked", "false")

      // Back on Home the activity card is gone.
      await gotoTab(page, "home")
      await expect(page.locator(".activity-card")).toHaveCount(0)
    })

    await step(page, 153, 1, async () => {
      // Toggle back on → card returns.
      await gotoTab(page, "settings")
      const toggleAgain = settingToggle(page, "Activity tracker")
      await toggleAgain.click()
      await expect(toggleAgain).toHaveAttribute("aria-checked", "true")
      await gotoTab(page, "home")
      await expect(page.locator(".activity-card")).toBeVisible({ timeout: 20_000 })
    })
  }
)
