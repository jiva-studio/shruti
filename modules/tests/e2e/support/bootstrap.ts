import fs from "fs"
import type { Page } from "@playwright/test"
import {
  assertFixturesPresent,
  CONTENT_DB_PATH,
  CONTENT_DB_VERSION,
  SILENT_MP3_PATH,
  TRANSCRIPT_JSON_PATH,
  userDbPath,
  type Locale,
} from "./fixtures.js"

/**
 * The whole bootstrap is lifted from the screenshot pipeline
 * (modules/tools/screenshots/specs/capture.spec.ts) with two deliberate
 * differences:
 *
 *  1. Audio is stubbed with a REAL ~1s silent MP3, not a 1-byte blob. A valid
 *     file lets `player.openTrack()` actually load + play, so the floating
 *     player opens on a real list tap (the play spec) instead of needing the
 *     debug bridge.
 *  2. `boot()` waits on the rendered DOM (the tab bar), NOT on
 *     `window.__shruti.debug`. The CI bundle has no debug bridge, so the
 *     suite must never depend on it.
 */

/* ---------------------- network interception ----------------------- */

/**
 * Intercept the only calls Welcome needs to come up offline + deterministically:
 *  - **​/public/config.json        → a fake manifest pinned to our content.db.
 *  - **​/public/db/shruti.*.db   → bytes from fixtures/content.db.
 *  - **​/public/tracks/*​/audio/*    → the silent MP3 stub (valid, so playback works).
 *  - **​/public/tracks/*​/transcripts/*.json → a fixture transcript (trackId patched
 *    to match the request) so the reader renders offline + deterministically.
 */
export async function interceptContent(page: Page): Promise<void> {
  const fakeConfig = JSON.stringify({
    databases: [
      { version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) },
    ],
    // Kill the proactive scheduler so it can't drop a "Sadhu has a new message"
    // banner over the home screen mid-test.
    proactive: { master_enabled: false },
  })
  await page.route("**/public/config.json", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: fakeConfig })
  })

  const dbBytes = fs.readFileSync(CONTENT_DB_PATH)
  await page.route("**/public/db/shruti.*.db", (route) => {
    route.fulfill({ status: 200, contentType: "application/octet-stream", body: dbBytes })
  })

  const mp3 = fs.readFileSync(SILENT_MP3_PATH)
  await page.route("**/public/tracks/*/audio/*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      headers: { "content-length": String(mp3.length) },
      body: mp3,
    })
  })

  // Serve one fixture transcript for every track, with its `trackId`/`language`
  // rewritten to match the requested URL so the reader doesn't reject it on a
  // mismatch. Keeps the transcript spec offline and independent of which queued
  // track happens to be tapped first.
  const transcriptFixture = JSON.parse(fs.readFileSync(TRANSCRIPT_JSON_PATH, "utf-8")) as Record<
    string,
    unknown
  >
  await page.route("**/public/tracks/*/transcripts/*.json", (route) => {
    const m = /\/tracks\/([^/]+)\/transcripts\/([^/.]+)\.json/.exec(route.request().url())
    const body = JSON.stringify({
      ...transcriptFixture,
      trackId: m?.[1] ?? transcriptFixture.trackId,
      language: m?.[2] ?? transcriptFixture.language,
    })
    route.fulfill({ status: 200, contentType: "application/json", body })
  })
}

/* ---------------------- IndexedDB / Preferences pre-seed ------------------ */

/**
 * Write the seeded user.db into IndexedDB BEFORE the app boots. The web
 * `useSqlJsPersistence` reads `(shruti, databases, user.db)` on open() and
 * only creates an empty DB when the key is missing, so a pre-seeded blob is
 * picked up transparently and migrations no-op. The fixture carries ~9 playlist
 * tracks, listening history and notes (see screenshots/generate-fixtures).
 */
export async function preseedUserDb(page: Page, locale: Locale): Promise<void> {
  const base64 = fs.readFileSync(userDbPath(locale)).toString("base64")
  await page.addInitScript(
    ({ b64 }: { b64: string }) => {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const req = indexedDB.open("shruti", 1)
      req.onupgradeneeded = () => req.result.createObjectStore("databases")
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(["databases"], "readwrite")
        tx.objectStore("databases").put(arr, "user.db")
        tx.oncomplete = () => db.close()
      }
    },
    { b64: base64 }
  )
}

/**
 * Pin the library (TracksView) to the Bhagavad-gita source so it shows a stable,
 * populated, reference-sorted list. Capacitor Preferences on web → localStorage
 * under the `CapacitorStorage.` prefix.
 */
export async function preseedSearchFilter(page: Page, locale: Locale): Promise<void> {
  const filters = {
    authorIds: [],
    languageCodes: [locale],
    locationIds: [],
    sourceIds: ["source_dsicuBsFvinZ"],
    tagIds: [],
    duration: [],
    sort: "byReference",
  }
  await page.addInitScript(
    ({ value }: { value: string }) => {
      try {
        localStorage.setItem("CapacitorStorage.search.filters.v3", value)
      } catch {
        /* unavailable origin — non-fatal */
      }
    },
    { value: JSON.stringify(filters) }
  )
}

/** Park the Home "enable reminders" nag in its cooldown so it can't cover rows. */
export async function preseedDismissedNags(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "CapacitorStorage.home.notificationsNag.dismissedAt",
        JSON.stringify(2_000_000_000_000)
      )
    } catch {
      /* non-fatal */
    }
  })
}

/* ------------------------------ boot ------------------------------- */

const KILL_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-duration: 0ms !important;
    animation-delay: 0ms !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
  }
`

/**
 * Bring the app up to a ready Home tab. Asserts on the rendered DOM (the tab
 * bar) rather than the debug bridge so the same boot works against the CI
 * bundle. After this returns the app is interactive and the playlist is seeded.
 */
export async function boot(
  page: Page,
  locale: Locale = "en",
  opts: { dismissNags?: boolean } = {}
): Promise<void> {
  const { dismissNags = true } = opts
  assertFixturesPresent()
  await interceptContent(page)
  await preseedUserDb(page, locale)
  await preseedSearchFilter(page, locale)
  if (dismissNags) await preseedDismissedNags(page)

  await page.goto(`/?locale=${locale}`)
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}
