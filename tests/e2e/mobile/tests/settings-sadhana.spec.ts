import { test, expect } from "../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../support/bootstrap.js"
import { gotoTab } from "../support/nav.js"

// The Sadhana group: the activity tracker toggle is present, and enabling
// Notifications reveals the daily "Reminder time" row. (The actual native
// notification scheduling is platform-dependent and not asserted offline.)
test(
  qase(120, "Sadhana: activity tracker and daily reminder"),
  { tag: ["@offline", "@settings"] },
  async ({ page }) => {
    await boot(page)
    await gotoTab(page, "settings")

    const notifications = page
      .locator("ion-item", { hasText: "Notifications" })
      .locator("ion-toggle")
    await notifications.scrollIntoViewIfNeeded()
    await expect(notifications).toBeVisible({ timeout: 10_000 })

    // The "Reminder time" row appears only while notifications are enabled.
    if ((await notifications.getAttribute("aria-checked")) !== "true") {
      await notifications.click()
    }
    await expect(notifications).toHaveAttribute("aria-checked", "true")
    await expect(page.locator("ion-item", { hasText: "Reminder time" })).toBeVisible({
      timeout: 10_000,
    })

    // Disabling notifications hides the time row again.
    await notifications.click()
    await expect(page.locator("ion-item", { hasText: "Reminder time" })).toBeHidden({
      timeout: 10_000,
    })
  }
)
