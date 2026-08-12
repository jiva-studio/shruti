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
import { askChat, delta, status } from "../../support/chat-mock.js"
import { mockChatAuth } from "../../support/auth-mock.js"
import { startSseServer, allowSseServer, type SseServer } from "../../support/sse-server.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A HALF-OPEN chat stream: the server accepts the turn, writes a frame, and
 * then goes quiet without ever closing. It is the failure the 45 s stall
 * timeout exists for, and it cannot be expressed as a `page.route` — a route
 * fulfils in one piece, so a mocked stream is either complete or absent, never
 * hanging. Hence a real socket (`support/sse-server.ts`), reached by pointing a
 * region's `chatBaseUrl` at it through a `config.json` fixture — the technique
 * `region-failover.spec.ts` uses for its fake edges.
 *
 * Two outcomes, because the stall itself decides neither:
 *   - the server has the turn buffered → the resume poll replays the whole
 *     answer and the user never learns the socket died (case 270);
 *   - the server has nothing → after the recovery window the user gets a Retry
 *     instead of dots that spin for the buffer's 24 h TTL (case 271).
 */

/** A region block pointing chat at `origin` and everything else at the dead
 *  loopback sink. Shape must satisfy `regionsRegistry.isValidRegion`. */
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

/** Boot the app with chat pointed at the stalling socket. */
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
  // Registered after `interceptContent`, so this one wins over the sink config.
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

test(
  qase(270, caseTitle(270)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    // 45 s of stall + the resume round-trip on top of a cold boot.
    test.setTimeout(90_000)

    // One `status` frame and one `delta`, then silence for the rest of the run.
    // `stallAfter` is what keeps the connection open — never the frame count
    // (see the comment in support/sse-server.ts).
    const server = await startSseServer({
      frames: [status("searching_corpus"), delta("The soul is ")],
      stallAfter: 2,
    })

    try {
      await bootAgainst(page, server)

      // The turn the server buffered while our socket was dead. Registered
      // AFTER `allowSseServer` so it wins — otherwise this GET reaches the
      // stalling socket instead of this mock.
      let turnPolls = 0
      await page.route("**/chat/turn/*", (route) => {
        turnPolls += 1
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            state: "done",
            events: [
              { event: "delta", data: JSON.stringify({ text: ANSWER }) },
              { event: "done", data: "{}" },
            ],
          }),
        })
      })

      await step(page, 270, 0, async () => {
        await askChat(page, "What is the soul?")
        // The socket really streamed: the partial prose is on screen, and the
        // thinking pill carries the server's own `status` label — a frame no
        // fulfilled route can deliver mid-stream, because a fulfilled route has
        // no mid-stream.
        await expect(page.getByText("The soul is").first()).toBeVisible({ timeout: 30_000 })
        await expect(page.locator(".status-pill")).toContainText("Searching the recordings", {
          timeout: 15_000,
        })
      })

      await step(page, 270, 1, async () => {
        // Nothing more ever arrives on the socket. Within the 45 s stall window
        // + one resume poll the buffered answer replaces the partial text.
        await expect(page.getByText(/never born and it never dies/i)).toBeVisible({
          timeout: 60_000,
        })
        expect(turnPolls).toBeGreaterThan(0)
      })

      await step(page, 270, 2, async () => {
        // A recovered stall is not a failure: no failed bubble, no inline
        // notice, and the thinking pill is gone.
        await expect(page.locator(".inline-notice")).toHaveCount(0)
        await expect(page.locator(".status-pill")).toHaveCount(0)
      })
    } finally {
      await server.close()
    }
  }
)

test(
  qase(271, caseTitle(271)),
  { tag: ["@offline", "@chat"] },
  async ({ page }) => {
    // 45 s stall + the ~15 s recovery window + a retry, on top of a cold boot.
    test.setTimeout(120_000)

    // Headers, then nothing at all — the stall with no prose behind it.
    const server = await startSseServer({ frames: [], stallAfter: 0 })

    try {
      await bootAgainst(page, server)

      // The server has no buffer for this turn: every resume poll 404s, so
      // recovery is attempted and comes back empty.
      let turnPolls = 0
      await page.route("**/chat/turn/*", (route) => {
        turnPolls += 1
        route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      })

      await step(page, 271, 0, async () => {
        await askChat(page, "What is the soul?")
        await expect(page.getByText("What is the soul?").first()).toBeVisible({ timeout: 20_000 })
        // Still generating, as far as the app knows.
        await expect(page.locator(".status-pill")).toBeVisible({ timeout: 20_000 })
      })

      let retry = page.locator(".inline-notice").first().locator(".btn")
      await step(page, 271, 1, async () => {
        // Stall → resume poll → repeated 404s → the recovery window closes and
        // the spinner becomes an affordance. Same inline notice the failed
        // bubble uses (case 83), so a stalled turn grows no second UI.
        const notice = page.locator(".inline-notice").first()
        await expect(notice).toBeVisible({ timeout: 90_000 })
        retry = notice.locator(".btn")
        await expect(retry).toBeVisible()
        expect(turnPolls).toBeGreaterThan(0)
      })

      await step(page, 271, 2, async () => {
        const before = server.requests()
        await retry.click()
        // Retry re-sends the same question — a second POST /chat on the wire.
        await expect
          .poll(() => server.requests(), { timeout: 20_000 })
          .toBeGreaterThan(before)
      })
    } finally {
      await server.close()
    }
  }
)
