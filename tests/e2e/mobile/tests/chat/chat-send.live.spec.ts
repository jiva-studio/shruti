import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { bootLive, askChat, assistantBubble } from "../../support/live.js"
import { step, caseTitle } from "../../support/steps.js"

// The live half of case 82, whose offline half is chat-stream.spec.ts: the same
// journey, but nothing is intercepted — the app talks to the local stack (chat
// + auth), so this asserts the BACKEND answers, not that the widget can render a
// canned stream.
//
// A real answer is not deterministic, so the assertion is on its shape: the
// assistant bubble fills with a substantial amount of prose. Asserting words
// would make the run depend on the model of the day.
test(qase(82, caseTitle(82)), { tag: ["@live", "@chat"] }, async ({ page }) => {
  // A real turn is minutes, not seconds: the app boots against the prod CDN, the
  // router picks a worker, and the research path fans out over the corpus before
  // a token is streamed. The suite-wide 120s is an offline budget; this one test
  // asks for its own.
  test.setTimeout(360_000)

  await bootLive(page, "en")

  await step(page, 82, 0, async () => {
    await askChat(page, "What is bhakti?")
    await expect(page.getByText("What is bhakti?").first()).toBeVisible({ timeout: 20_000 })
  })

  await step(page, 82, 1, async () => {
    await expect(assistantBubble(page)).toBeVisible({ timeout: 120_000 })
    await expect
      .poll(async () => (await assistantBubble(page).innerText()).trim().length, {
        timeout: 240_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(80)
  })
})
