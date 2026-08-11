import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { gotoTab } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import { installIngestMock } from "../../../support/ingest-mock.js"
import {
  mockChatAuth,
  mockChatStream,
  askChat,
  delta,
  action,
  done,
} from "../../../support/chat-mock.js"

// Chat is discovery-only: the card it renders offers a lecture, and confirming
// it goes out over the orchestrator's ingest API like every other add. Both
// halves are stubbed — the SSE answer carries the candidate, the ingest mock
// answers the submit — so what is under test is the wiring between them.

const CANDIDATE = {
  url: "https://archive.example/talks/0042.mp3",
  title: "The glories of the holy name",
  author: "Test Speaker",
}

test(qase(208, caseTitle(208)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  const ingest = await installIngestMock(page)
  await mockChatAuth(page, "pro")
  await mockChatStream(page, [
    action({ kind: "add_to_library", id: "a1", payload: { ...CANDIDATE, thumbnail: null } }),
    delta(`I found this one:\n\n[action:add_to_library|id=a1]`),
    done(),
  ])
  await boot(page, "en", { pro: true, userDb: "clean" })
  await gotoTab(page, "chat")

  const card = page.locator(".add-card .track-tile")

  await step(page, 208, 0, async () => {
    await askChat(page, "Find me a lecture about the holy name")
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText(CANDIDATE.title)
    await expect(card.locator("button.add")).toBeVisible()
  })

  await step(page, 208, 1, async () => {
    await card.locator("button.add").click()
    await expect(card.locator(".ingest-badge")).toBeVisible({ timeout: 30_000 })
    expect(ingest.submits).toEqual([
      { url: CANDIDATE.url, title: CANDIDATE.title, author: CANDIDATE.author },
    ])
  })
})
