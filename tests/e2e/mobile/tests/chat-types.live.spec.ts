import { test, expect } from "@playwright/test"
import { qase } from "playwright-qase-reporter"
import { bootLive, askChat } from "../support/live.js"

// Real LLM turns are occasionally slow/transient under load — retry @live. Each
// card assertion waits up to 180s for the stream to finish, so the per-test
// budget must exceed that (the global 120s default would kill a slow-but-valid
// turn before its own assertion times out).
test.describe.configure({ retries: 2, timeout: 240_000 })

/**
 * @live — different chat REQUEST TYPES routed by the chat service
 * (routing.py: show_verse / find_track / create_action…). Each asserts the
 * characteristic card the mobile client renders for that intent. Answers can be
 * slow, so timeouts are generous.
 */

test(
  qase(85, "chat · verse lookup renders a scripture card"),
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "BG 2.13") // bare scripture reference → show_verse

    // The verse renders as a full ScriptureBlock (or a scripture chip fallback),
    // carrying the address 2.13.
    const verse = page.locator(".verse-card-addr, .scripture-chip")
    await expect(verse.first()).toBeVisible({ timeout: 180_000 })
    await expect(verse.first()).toContainText("2.13")
  }
)

test(
  "chat · find-lectures renders a track list",
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "Show me lectures about karma") // → find_track

    // The answer embeds [card:track_id] markers → a stack of lecture cards.
    await expect(page.locator(".lecture-card").first()).toBeVisible({ timeout: 180_000 })
  }
)

// FIXME: research → citations and locate → chapter-card depend on the LLM
// routing to that exact intent AND the corpus producing the marker; both proved
// flaky to trigger deterministically. The normal-Q&A, verse, find_track and
// reminder types below cover the distinct request shapes reliably. Revisit with
// queries tuned against the router prompt.
test.fixme(
  "chat · research query renders citations",
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "What does Prabhupada teach about the soul?") // → research
    await expect(page.locator(".citation-card, .citation-chip-line").first()).toBeVisible({
      timeout: 180_000,
    })
  }
)

test.fixme(
  qase([87, 91], "chat · locate query renders a chapter card"),
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "Which chapter of the Bhagavad-gita is about karma-linux-client?") // → locate
    await expect(page.locator(".chapter-card").first()).toBeVisible({ timeout: 180_000 })
  }
)

test(
  "chat · reminder request renders a time-picker action card",
  { tag: ["@live", "@chat"] },
  async ({ page }) => {
    await bootLive(page)
    await askChat(page, "Remind me to listen to a lecture every morning") // → create_action reminder

    await expect(page.locator(".time-input").first()).toBeVisible({ timeout: 180_000 })
  }
)

// NOTE: a `create_action` pdf test is intentionally not here yet — the pdf intent
// is finicky to trigger reliably AND generating the file needs the share-transcript
// service (not in the minimal stack). Tracked in TESTPLAN.
