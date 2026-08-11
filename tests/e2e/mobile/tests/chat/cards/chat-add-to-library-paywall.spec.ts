import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"
import { mockChatStream, askChat, delta, action, done } from "../../../support/chat-mock.js"
import { mockChatAuth } from "../../../support/auth-mock.js"

// The free half of case 208. Adding a lecture is Pro, so for every non-
// subscriber the tap ends at the subscription page with nothing submitted —
// that is the designed path, not an edge case. What the spec watches is what
// the card looks like AFTERWARDS: the store used to read "addByUrl returned"
// as success, write `done`, and persist it, which left a tile with no control
// at all over a lecture that was never fetched (#1727).

const CANDIDATE = {
  url: "https://archive.example/talks/0043.mp3",
  title: "A lecture a free user cannot add yet",
  author: "Test Speaker",
}

test(qase(225, caseTitle(225)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  const ingest = await installIngestMock(page)
  await mockChatAuth(page, "free")
  await mockChatStream(page, [
    action({ kind: "add_to_library", id: "a1", payload: { ...CANDIDATE, thumbnail: null } }),
    delta(`I found this one:\n\n[action:add_to_library|id=a1]`),
    done(),
  ])
  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  const card = page.locator(".add-card .track-tile")

  await step(page, 225, 0, async () => {
    await askChat(page, "Find me a lecture about the holy name")
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText(CANDIDATE.title)
    await expect(card.locator("button.add")).toBeVisible()
  })

  await step(page, 225, 1, async () => {
    await card.locator("button.add").click()
    await expect(page.locator(".subscription-page")).toBeVisible({ timeout: 15_000 })
    // Chat is discovery-only and the gate is client-side, so the orchestrator
    // must not have been asked for anything.
    expect(ingest.submits).toEqual([])
  })

  await step(page, 225, 2, async () => {
    await page.goBack()
    await expect(card).toBeVisible({ timeout: 15_000 })
    // The whole point: still an offer. A tile that lost its plus here is a
    // lecture the user can never add without starting a fresh conversation.
    await expect(card.locator("button.add")).toBeVisible({ timeout: 15_000 })
    expect(ingest.submits).toEqual([])
  })
})
