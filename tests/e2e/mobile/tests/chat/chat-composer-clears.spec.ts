import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../support/bootstrap.js"
import { gotoTab } from "../../support/nav.js"
import { mockChatStream, askChat, delta, done } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { step, caseTitle } from "../../support/steps.js"

// The composer must be blank once the turn is away (#1885): it used to keep the
// question, so the next Enter — or the next tap on send — spent a second
// quota-counted turn on the identical text.
test(qase(540, caseTitle(540)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  await mockChatAuth(page)
  await mockChatStream(page, [delta("The soul is eternal."), done()])

  let turns = 0
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/chat")) turns += 1
  })

  await boot(page, "en", { userDb: "clean" })
  await gotoTab(page, "chat")

  const input = page.locator(".chat-inputbar textarea")
  // The question also titles the session in the header, so count bubbles, not
  // occurrences of the text on the page.
  const asked = page.locator(".bubble.user .user-text", { hasText: "What is the soul?" })

  await step(page, 540, 0, async () => {
    await askChat(page, "What is the soul?")

    await expect(asked).toHaveCount(1, { timeout: 15_000 })
    await expect(input).toHaveValue("")
  })

  await step(page, 540, 1, async () => {
    await expect(page.getByText(/soul is eternal/i)).toBeVisible({ timeout: 20_000 })
    expect(turns).toBe(1)

    // Enter on the emptied capsule has nothing to send.
    await input.focus()
    await input.press("Enter")
    await page.waitForTimeout(1000)

    expect(turns).toBe(1)
    await expect(asked).toHaveCount(1)
  })
})
