import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../../support/bootstrap.js"
import { CONTENT_DB_VERSION } from "../../../support/fixtures.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * A dead edge must not cost the device its identity.
 *
 * The regions are alternate doors in front of ONE backend (the RU box proxies
 * `/auth/*` to the global host), so the anonymous mint may be re-issued on
 * another door: it is a device-keyed upsert against the same auth DB. Without
 * that, a first launch on an unreachable edge ends with no token at all —
 * chat, sync and ingest all off — and nothing recovers it, because the startup
 * probe only checks the storage host, which is a different machine.
 *
 * Two regions are published; the app settles on edge-a, whose auth service is
 * dead. The token must still be minted, from edge-b.
 */
function region(id: string, host: string) {
  return {
    id,
    name: id,
    urlTemplate: `https://${host}/{path}`,
    shareAudioUrl: `https://${host}/share/audio/excerpts`,
    shareVideoUrl: `https://${host}/share/video/reels`,
    shareTranscriptUrl: `https://${host}/share/transcripts`,
    authBaseUrl: `https://${host}/auth`,
    chatBaseUrl: `https://${host}`,
    profileBaseUrl: `https://${host}`,
    orchestratorBaseUrl: `https://${host}`,
    discoveryBaseUrl: `https://${host}`,
  }
}

function jwt(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const claims = Buffer.from(JSON.stringify({ exp, tier: "free", quota_id: "q1" })).toString(
    "base64"
  )
  return `h.${claims}.s`
}

test(qase(190, caseTitle(190)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedOnboardingDone(page)
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)

  await page.route("**/public/config.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        databases: [
          { version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) },
        ],
        proactive: { master_enabled: false },
        regions: [region("edge-a", "edge-a.test"), region("edge-b", "edge-b.test")],
      }),
    })
  )

  // edge-a is the active region and its auth service is down; edge-b answers.
  let edgeAHits = 0
  let edgeBHits = 0
  await page.route("https://edge-a.test/auth/anonymous", (route) => {
    edgeAHits++
    void route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
  })
  await page.route("https://edge-b.test/auth/anonymous", (route) => {
    edgeBHits++
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: jwt(),
        refreshToken: "e2e-refresh",
        userId: "u-e2e",
        anonymous: true,
      }),
    })
  })
  await page.route("https://edge-b.test/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        userId: "u-e2e",
        email: null,
        name: null,
        pictureUrl: null,
        anonymous: true,
        tier: "free",
      }),
    })
  )

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })

  await step(page, 190, 0, async () => {
    // The identity floor holds: a token exists despite the preferred edge.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const raw = localStorage.getItem("CapacitorStorage.auth.tokens")
            return raw ? ((JSON.parse(raw) as { accessToken?: string }).accessToken ?? "") : ""
          }),
        { timeout: 30_000 }
      )
      .not.toBe("")
  })

  await step(page, 190, 1, async () => {
    // And it was genuinely re-issued on the other door — asked once each, so
    // the walk is a failover and not a fan-out at an already-failing backend.
    expect(edgeAHits, "the dead edge is asked first").toBe(1)
    expect(edgeBHits, "the live edge mints the identity").toBe(1)
  })
})
