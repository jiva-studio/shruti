import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, settingToggle } from "../../support/nav.js"

// Persistence + cross-tab effect of useConfig-backed settings. No existing spec
// reloads the page, so test 1 specifically proves the setting survives a full
// app re-hydration (IndexedDB-backed user.db / Preferences).

test(
  qase(117, "Appearance toggles persist across restart"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en")
    await gotoTab(page, "settings")

    // "Open transcript automatically" — record its seeded value, flip it.
    const toggle = settingToggle(page, "Open transcript automatically")
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    const before = await toggle.getAttribute("aria-checked")
    const flipped = before === "true" ? "false" : "true"

    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", flipped)

    // Full re-hydration: reload the bundle, wait for the tab bar (boot's own
    // ready signal), then re-navigate to settings. The persisted value must
    // come back as the flipped one — not the seeded default.
    await page.reload()
    await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
    await gotoTab(page, "settings")

    const after = settingToggle(page, "Open transcript automatically")
    await expect(after).toBeVisible({ timeout: 20_000 })
    await expect(after).toHaveAttribute("aria-checked", flipped)
  }
)

test(
  qase(117, "Appearance toggles — activity tracker hides the Home card"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page, "en")

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

    // Toggle back on → card returns.
    await gotoTab(page, "settings")
    const toggleAgain = settingToggle(page, "Activity tracker")
    await toggleAgain.click()
    await expect(toggleAgain).toHaveAttribute("aria-checked", "true")
    await gotoTab(page, "home")
    await expect(page.locator(".activity-card")).toBeVisible({ timeout: 20_000 })
  }
)
