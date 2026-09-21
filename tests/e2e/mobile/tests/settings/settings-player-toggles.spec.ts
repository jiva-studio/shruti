import type { Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab, playFirstQueuedTrack, settingToggle } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

// Two appearance toggles whose whole point is an effect on another screen.
// A persistence-only assertion would pass on a setting nothing reads.

async function flip(page: Page, label: string, to: "true" | "false"): Promise<void> {
  await gotoTab(page, "settings")
  const toggle = settingToggle(page, label)
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  if ((await toggle.getAttribute("aria-checked")) !== to) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", to)
}

test(qase(601, caseTitle(601)), { tag: ["@offline", "@settings", "@player"] }, async ({ page }) => {
  await boot(page)
  const ring = page.locator(".play-fixed .progress")

  await step(page, 601, 0, async () => {
    await gotoTab(page, "home")
    await playFirstQueuedTrack(page)
    await expect(ring).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 601, 1, async () => {
    await flip(page, "Player progress", "false")
    await gotoTab(page, "home")
    await expect(page.locator(".player")).not.toHaveClass(/\bhidden\b/)
    await expect(ring).toHaveCount(0)
  })

  await step(page, 601, 2, async () => {
    await flip(page, "Player progress", "true")
    await gotoTab(page, "home")
    await expect(ring).toBeVisible({ timeout: 20_000 })
  })
})

test(qase(602, caseTitle(602)), { tag: ["@offline", "@settings", "@notes"] }, async ({ page }) => {
  await boot(page)
  const notes = page.locator(".note[role=button]")
  const players = page.locator(".notes-inline-player")
  let noteCount = 0

  await step(page, 602, 0, async () => {
    await gotoTab(page, "notes")
    await expect(notes.first()).toBeVisible({ timeout: 20_000 })
    noteCount = await notes.count()
    expect(noteCount).toBeGreaterThan(0)
    await expect(players.first()).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 602, 1, async () => {
    await flip(page, "Player on notes page", "false")
    await gotoTab(page, "notes")
    await expect(notes).toHaveCount(noteCount)
    await expect(players).toHaveCount(0)
  })

  await step(page, 602, 2, async () => {
    await flip(page, "Player on notes page", "true")
    await gotoTab(page, "notes")
    await expect(players.first()).toBeVisible({ timeout: 20_000 })
  })
})
