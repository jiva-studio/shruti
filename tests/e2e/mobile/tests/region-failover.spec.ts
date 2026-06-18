import fs from "fs"
import { test, expect } from "../support/test.js"
import {
  interceptContent,
  preseedUserDb,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../support/bootstrap.js"
import { CONTENT_DB_VERSION } from "../support/fixtures.js"
import { gotoTab } from "../support/nav.js"

/**
 * CDN region failover for assets: when the active region's host is dead,
 * covers (and every asset resolved via files storage) must fail over to
 * another region and promote it — instead of staying blank until restart.
 *
 * We publish a two-region config (hosts edge-a / edge-b), let the app settle on
 * edge-a, then block edge-a's cover host and serve edge-b's. With the fix every
 * cover still decodes (served from edge-b) and edge-b is actually requested —
 * proof the failover ran, not just a cache hit.
 */

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64"
)

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
  }
}

test(
  "library · covers fail over to a live region when the active CDN host is dead",
  { tag: ["@offline", "@library"] },
  async ({ page }) => {
    // Base content routes (db / audio / transcripts), then override config.json
    // with a two-region block so the app has edge-a (active) + edge-b (fallback).
    await interceptContent(page)
    const config = JSON.stringify({
      databases: [
        { version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) },
      ],
      proactive: { master_enabled: false },
      regions: [region("edge-a", "edge-a.test"), region("edge-b", "edge-b.test")],
    })
    await page.route("**/public/config.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: config })
    )

    // edge-a (active) is dead for covers; edge-b serves them. Count edge-b hits
    // to prove the failover actually re-targeted the request.
    await page.route("https://edge-a.test/public/collections/**", (route) =>
      route.abort("failed")
    )
    let edgeBHits = 0
    await page.route("https://edge-b.test/public/collections/**", (route) => {
      edgeBHits++
      route.fulfill({ status: 200, contentType: "image/png", body: PNG_1x1 })
    })

    await preseedUserDb(page, "en")
    await preseedSearchFilter(page, "en")
    await preseedDismissedNags(page)

    await page.goto("/?locale=en")
    await page.waitForURL("**/tabs/home", { timeout: 60_000 })

    await gotoTab(page, "search")
    const cards = page.locator(".carousel-section .collection-card, .tile-grid .collection-card")
    await cards.first().waitFor({ state: "visible", timeout: 20_000 })

    // With failover, covers decode (served from edge-b) and edge-b was hit.
    await expect(async () => {
      expect(edgeBHits).toBeGreaterThan(0)
      const loaded = await page.locator(".collection-card .cached-image.is-loaded").count()
      expect(loaded).toBeGreaterThan(0)
    }).toPass({ timeout: 25_000 })

    const decoded = await page
      .locator(".collection-card .cached-image.is-loaded")
      .evaluateAll((imgs) => imgs.every((el) => (el as HTMLImageElement).naturalWidth > 0))
    expect(decoded).toBe(true)
  }
)
