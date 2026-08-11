import fs from "fs"
import { test, expect } from "../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../support/bootstrap.js"
import { CONTENT_DB_VERSION, SILENT_MP3_PATH } from "../../support/fixtures.js"
import { gotoTab, openLibrary, openTrackSheet, playlistRows, trackRows, trackSheet } from "../../support/nav.js"
import { step, caseTitle } from "../../support/steps.js"

/**
 * A dead CDN costs seconds, not minutes.
 *
 * The walk used to be strictly serial: candidate 1 was given its full connect
 * timeout before candidate 2 was tried at all, so a region that accepts the
 * connection and then never answers held the whole download for the length of
 * that timeout — minutes, per lecture. The hedge starts the next candidate
 * after HEDGE_INTERVAL_MS without cancelling the first, and whichever answers
 * first wins.
 *
 * Case 78 covers failover for *assets* (covers). This is the audio download
 * walk, which is a different path.
 */
const HEDGE_INTERVAL_MS = 5_000

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

test(qase(187, caseTitle(187)), { tag: ["@offline", "@library"] }, async ({ page }) => {
  test.setTimeout(120_000)

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

  // The catalog itself must still load — only audio is under test.
  const mp3 = fs.readFileSync(SILENT_MP3_PATH)
  const start = Date.now()
  let edgeBFirstHitAt = 0
  let edgeBHits = 0

  // edge-a accepts the request and never answers: the shape a dead region
  // actually takes, and the one a connect timeout alone cannot cut short.
  await page.route("https://edge-a.test/public/tracks/*/audio/*", () => {})
  await page.route("https://edge-b.test/public/tracks/*/audio/*", (route) => {
    edgeBHits++
    if (!edgeBFirstHitAt) edgeBFirstHitAt = Date.now() - start
    void route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      headers: { "content-length": String(mp3.length) },
      body: mp3,
    })
  })

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })

  let title = ""

  await step(page, 187, 0, async () => {
    await openLibrary(page)
    const first = trackRows(page).first()
    title = (await first.locator(".title").innerText()).trim()
    await openTrackSheet(page, first)
    await trackSheet(page).locator(".add-btn").click()
    await expect(trackSheet(page)).toBeHidden()
  })

  await step(page, 187, 1, async () => {
    // The download completes from the live region rather than parking on the
    // silent one. Before the hedge this waited out edge-a's whole timeout.
    await gotoTab(page, "home")
    const queued = playlistRows(page).filter({ hasText: title }).first()
    await expect(queued).toBeVisible({ timeout: 20_000 })
    // The live region is asked and serves the bytes.
    await expect.poll(() => edgeBHits, { timeout: 45_000 }).toBeGreaterThan(0)

    // And the download is reported done, with edge-a's request still hanging.
    // Read on the Library row: the Home queue draws a PLAYBACK radial for a
    // queued track, so the state icon is absent there whether the file arrived
    // or not — which is what made #1682 look like a stuck download. The search
    // tab still holds the query from step 0, so going back to it is enough.
    await gotoTab(page, "search")
    await expect(
      trackRows(page).filter({ hasText: title }).first().locator('[data-testid="track-state"]')
    ).toHaveAttribute("data-state", /added|completed/, { timeout: 45_000 })
  })

  await step(page, 187, 2, async () => {
    // And the head candidate genuinely ran alone first — a hedge that fires
    // immediately is just a fan-out, and would multiply CDN load per download.
    expect(edgeBFirstHitAt).toBeGreaterThanOrEqual(HEDGE_INTERVAL_MS - 1_000)
  })
})
