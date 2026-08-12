import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The Notes search box (NotesView.vue → `<SearchInput>`) filters the list and,
 * for queries of length >= MATCH_HIGHLIGHT_MIN_LENGTH (4), wraps matches in
 * `<mark>` via `highlightMatches`. The note excerpt body renders inside
 * `.highlight-text` (HighlightText primitive); attribution (author/title) lives
 * in a separate `.meta-block`, so we read the query word from `.highlight-text`
 * to be sure we're matching the body text the highlighter operates on.
 *
 * The Android `<SearchInput>` is an `<ion-input>`; its native field is
 * `.search-input ion-input input`.
 */
function notesSearchInput(page: import("@playwright/test").Page) {
  return page.locator(".search-input ion-input input")
}

/** Pick the first word of >= 4 letters/digits from a blob of note text. */
function pickHighlightWord(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]{4,}/gu)
  return words && words.length > 0 ? words[0]! : null
}

test(
  qase(4, caseTitle(4)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    let total = 0
    const input = notesSearchInput(page)

    await step(page, 4, 0, async () => {
      await gotoTab(page, "notes")

      const notes = page.locator(".note[role=button]")
      await expect(notes.first()).toBeVisible({ timeout: 20_000 })
      total = await notes.count()
      expect(total).toBeGreaterThan(0)

      // Read a >= 4-char word from the first note's body (not its attribution).
      const bodyText = (await notes.first().locator(".highlight-text").innerText()).trim()
      const word = pickHighlightWord(bodyText)
      expect(word, `no >=4-char word in first note body: "${bodyText}"`).not.toBeNull()

      await expect(input).toBeVisible({ timeout: 10_000 })
      await input.fill(word!)

      // Filtered list: at least one match, never more than the full set, and a
      // visible `<mark>` proving the highlighter ran (length >= 4 → wrap).
      await expect
        .poll(() => page.locator(".note[role=button]").count(), { timeout: 15_000 })
        .toBeGreaterThan(0)
      const filtered = await page.locator(".note[role=button]").count()
      expect(filtered).toBeGreaterThanOrEqual(1)
      expect(filtered).toBeLessThanOrEqual(total)
      await expect(page.locator(".note[role=button] mark").first()).toBeVisible({ timeout: 10_000 })
    })

    await step(page, 4, 1, async () => {
      // Clearing the box restores the full list.
      await input.fill("")
      await expect
        .poll(() => page.locator(".note[role=button]").count(), { timeout: 15_000 })
        .toBe(total)
    })
  }
)

/**
 * A query nothing matches. `isEmpty` used to be computed from the UNFILTERED
 * corpus while the list rendered the filtered rows, so the sticker was
 * suppressed and the list had nothing to draw: a header over a blank page,
 * with no way to tell a filter from a bug.
 */
test(
  qase(298, caseTitle(298)),
  { tag: ["@offline", "@notes"] },
  async ({ page }) => {
    await boot(page)

    const notes = page.locator(".note[role=button]")
    const sticker = page.locator(".page-sticker")
    const input = notesSearchInput(page)
    let total = 0

    await step(page, 298, 0, async () => {
      await gotoTab(page, "notes")
      await expect(notes.first()).toBeVisible({ timeout: 20_000 })
      total = await notes.count()

      await expect(input).toBeVisible({ timeout: 10_000 })
      // Not a word: no seeded note can contain it in any locale.
      await input.fill("zqxjvwkbmpfhg")

      await expect(notes).toHaveCount(0, { timeout: 15_000 })
      await expect(sticker).toBeVisible({ timeout: 10_000 })
      const header = sticker.locator(".sticker-header")
      await expect(header).toHaveText(/nothing found/i)
      // …and a line saying WHY, so the state is readable and not just empty.
      const message = (await sticker.locator(".sticker-message").innerText()).trim()
      expect(message.length).toBeGreaterThan(0)
      // The onboarding copy belongs to a user with no notes at all — this one
      // has plenty, they just don't match.
      expect(message.toLowerCase()).not.toContain("add notes from lectures")
      // The box has to stay reachable, or the state is a dead end.
      await expect(input).toBeVisible()
    })

    await step(page, 298, 1, async () => {
      await input.fill("")
      await expect(sticker).toBeHidden({ timeout: 10_000 })
      await expect.poll(() => notes.count(), { timeout: 15_000 }).toBe(total)
    })
  }
)
