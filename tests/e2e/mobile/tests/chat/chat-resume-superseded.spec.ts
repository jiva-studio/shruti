import type { Page } from "@playwright/test"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
  SINK_ORIGIN,
} from "../../support/bootstrap.js"
import { CONTENT_DB_VERSION } from "../../support/fixtures.js"
import { gotoTab } from "../../support/nav.js"
import { askChat, delta } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { startSseServer, allowSseServer, type SseServer } from "../../support/sse-server.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * Issue #1840. A stalled turn is handed to the resume poll; asking a new
 * question while that poll runs registers a controller for the session, and
 * the poll used to abandon the followed turn on sight of one — before any
 * `getTurn`. The answer the server had already produced was thrown away, and
 * the abandoned bubble's Retry is structurally unreachable (both affordances
 * need `isLast()`, and the newer question now sits after it).
 *
 * Same real-socket harness as the stall specs: a `page.route` fulfils in one
 * piece and so cannot stall mid-stream.
 */
function chatRegion(origin: string) {
  return {
    id: "global",
    name: "Global",
    urlTemplate: `${SINK_ORIGIN}/{path}`,
    shareAudioUrl: `${SINK_ORIGIN}/share/audio/excerpts`,
    shareVideoUrl: `${SINK_ORIGIN}/share/video/reels`,
    shareTranscriptUrl: `${SINK_ORIGIN}/share/transcripts`,
    authBaseUrl: `${SINK_ORIGIN}/auth`,
    chatBaseUrl: origin,
    profileBaseUrl: SINK_ORIGIN,
    orchestratorBaseUrl: SINK_ORIGIN,
    discoveryBaseUrl: SINK_ORIGIN,
  }
}

async function bootAgainst(page: Page, server: SseServer): Promise<void> {
  await mockChatAuth(page)
  await interceptContent(page)
  await preseedOnboardingDone(page)
  const config = JSON.stringify({
    databases: [
      { version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) },
    ],
    proactive: { master_enabled: false },
    regions: [chatRegion(server.origin)],
  })
  await page.route("**/public/config.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: config })
  )
  await allowSseServer(page, server)
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await gotoTab(page, "chat")
}

const ANSWER = "The soul is eternal — it is never born and it never dies."
const SECOND_QUESTION = "And who is Balarama?"

test(qase(354, caseTitle(354)), { tag: ["@offline", "@chat"] }, async ({ page }) => {
  // 45 s of stall, the re-ask, and a resume round-trip, on top of a cold boot.
  test.setTimeout(150_000)

  const server = await startSseServer({
    frames: [delta("The soul is ")],
    stallAfter: 1,
  })

  try {
    await bootAgainst(page, server)

    // The followed turn stays `running` until the user has re-asked — that is
    // the window the defect lived in — and only then reports its buffer.
    let firstTurnId: string | null = null
    let finished = false
    let turnPolls = 0
    await page.route("**/chat/turn/*", (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop() ?? ""
      firstTurnId ??= id
      turnPolls += 1
      // Only the turn we are following has a buffer; the second (also stalled)
      // turn's own poll must not be handed this answer as well.
      const state = id === firstTurnId && finished ? "done" : "running"
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state,
          events:
            state === "done"
              ? [
                  { event: "delta", data: JSON.stringify({ text: ANSWER }) },
                  { event: "done", data: "{}" },
                ]
              : [],
        }),
      })
    })

    await step(page, 354, 0, async () => {
      await askChat(page, "What is the soul?")
      await expect(page.getByText("The soul is").first()).toBeVisible({ timeout: 30_000 })
      // The socket never closes; after the stall window the turn is the resume
      // poll's, which is what a re-ask now has to survive.
      await expect.poll(() => turnPolls, { timeout: 90_000 }).toBeGreaterThan(0)
    })

    await step(page, 354, 1, async () => {
      // The composer is not disabled during a resume poll — this is an
      // ordinary impatient re-ask.
      await askChat(page, SECOND_QUESTION)
      await expect(page.getByText(SECOND_QUESTION).first()).toBeVisible({ timeout: 20_000 })
      finished = true

      await expect(page.getByText(/never born and it never dies/i)).toBeVisible({
        timeout: 60_000,
      })
    })

    await step(page, 354, 2, async () => {
      const slots = await page.locator(".msg-slot").allInnerTexts()
      const answerAt = slots.findIndex((s) => /never born and it never dies/i.test(s))
      const questionAt = slots.findIndex((s) => s.includes(SECOND_QUESTION))
      expect(answerAt).toBeGreaterThanOrEqual(0)
      expect(questionAt).toBeGreaterThanOrEqual(0)
      // Its own question is above it; the newer one is below.
      expect(answerAt).toBeLessThan(questionAt)
    })
  } finally {
    await server.close()
  }
})
