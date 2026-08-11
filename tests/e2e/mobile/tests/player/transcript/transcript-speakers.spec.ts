import fs from "fs"
import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import { boot } from "../../../support/bootstrap.js"
import { TRANSCRIPT_JSON_PATH } from "../../../support/fixtures.js"
import { openTranscript } from "../../../support/nav.js"
import { step, caseTitle } from "../../../support/steps.js"
import type { Page } from "@playwright/test"

/**
 * The reader's dialogue affordances — the per-line speaker icon and the "–" +
 * line break at a speaker change — only belong on a transcript that has more
 * than one speaker. `speakerChanged` alone cannot decide that: the grouper
 * resets its running speaker at every paragraph flush, so on a MONOLOGUE the
 * flag fires at the top of every paragraph and each one opened with a stray
 * dash. The gate used to be `allowMultipleLanguages`, which counts languages
 * and never fires for a single-language track anyway (issue #412 B/E).
 *
 * `.no-stretch` is the dash's own span in `SentenceBlock.vue` — the one
 * observable that says whether the affordance rendered.
 */
const DASH = ".transcript-text .no-stretch"

interface FixtureBlock {
  type: string
  speaker?: string
}

const fixture = JSON.parse(fs.readFileSync(TRANSCRIPT_JSON_PATH, "utf-8")) as {
  blocks: FixtureBlock[]
}

/** Serve the fixture transcript with every sentence attributed to `speakers`,
 *  cycled — one name makes it a monologue, several make it a dialogue. The
 *  trackId/language are patched to match the request, as bootstrap does. */
async function serveTranscript(page: Page, speakers: string[]): Promise<void> {
  const blocks = fixture.blocks.map((block, i) =>
    block.type === "sentence" ? { ...block, speaker: speakers[i % speakers.length] } : block
  )
  // The transcript is prefetched and cached on boot, so the route below is only
  // reached once the cache is gone.
  await page.evaluate(async () => {
    for (const k of await caches.keys()) await caches.delete(k)
  })
  await page.route("**/public/tracks/*/transcripts/*.json", (route) => {
    const m = /\/tracks\/([^/]+)\/transcripts\/([^/.]+)\.json/.exec(route.request().url())
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...fixture, blocks, trackId: m?.[1], language: m?.[2] }),
    })
  })
}

test(
  qase(191, caseTitle(191)),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "single" })
    await serveTranscript(page, ["Prabhupāda"])

    await step(page, 191, 0, async () => {
      await openTranscript(page)
      // Sanity: the reader really rendered this transcript's sentences.
      const dialog = page.locator("ion-modal.transcript-dialog")
      await expect(dialog.locator(".transcript-text [data-speaker]").first()).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.locator(DASH)).toHaveCount(0)
    })
  }
)

test(
  qase(192, caseTitle(192)),
  { tag: ["@offline", "@transcript"] },
  async ({ page }) => {
    await boot(page, "en", { userDb: "single" })
    await serveTranscript(page, ["Prabhupāda", "Guest"])

    await step(page, 192, 0, async () => {
      await openTranscript(page)
      const dialog = page.locator("ion-modal.transcript-dialog")
      await expect(dialog.locator(DASH).first()).toBeVisible({ timeout: 20_000 })
    })
  }
)
