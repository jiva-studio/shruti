import { test, type Page } from "@playwright/test"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { scenarios, type Scenario } from "../scenarios.js"
import { contentLanguageFor, parseProject, type CaptureLocale } from "../config.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(__dirname, "..")
const REPO_ROOT = path.resolve(TOOL_ROOT, "../../..")
const FIXTURES_DIR = path.resolve(TOOL_ROOT, "fixtures")

const CONTENT_DB_PATH = path.resolve(FIXTURES_DIR, "content.db")
/** Committed poster for the `07_media` remembrance clip — served by the
 *  `public/media/*.jpg` intercept (resources/ isn't available in CI). */
const MEDIA_POSTER_PATH = path.resolve(FIXTURES_DIR, "media/remembrance-poster.jpg")

/** The mobile app validates the cached / downloaded catalog DB against
 *  its compile-time `SUPPORTED_DB_SCHEME` (Vite `define` injection from
 *  `modules/db-scheme.json`). If the constant here drifts from that
 *  file, Welcome refuses to advance past the loading screen with
 *  "No compatible database for scheme ..." and the capture spec times
 *  out waiting for `/tabs/home`. Read it dynamically so a scheme bump
 *  doesn't quietly break the screenshot pipeline. */
const DB_SCHEME_PATH = path.resolve(REPO_ROOT, "modules/db-scheme.json")
const DB_SCHEME: number = (JSON.parse(fs.readFileSync(DB_SCHEME_PATH, "utf-8")) as { scheme: number })
  .scheme
/** Synthesised pinned version (yyyyMMddHHmmss). The first 8 digits MUST
 *  equal `DB_SCHEME` — that's the slice the fake config returns to
 *  Welcome as `databases[].scheme`. The trailing six digits are
 *  arbitrary; we just append `000000`. */
const CONTENT_DB_VERSION = Number(`${DB_SCHEME}000000`)

interface ProjectInfo {
  code: CaptureLocale
  device: string
}

function projectInfo(name: string): ProjectInfo {
  const { device, code } = parseProject(name)
  return { device, code: code as CaptureLocale }
}

/* ---------------------- network interception ----------------------- */

/**
 * Intercept the only two network calls Welcome needs:
 *  - `**​/public/config.json`        → fake manifest pointing at our content.db version
 *  - `**​/public/db/shruti.*.db`  → bytes from local fixtures/content.db
 *
 * Both real CDNs (S3, Yandex Cloud) and any localhost proxy match the
 * `**​/public/…` glob.
 */
async function interceptContent(page: Page): Promise<void> {
  if (!fs.existsSync(CONTENT_DB_PATH)) {
    throw new Error(
      `Missing ${CONTENT_DB_PATH}.\n` +
        `Copy resources/lake-out/artifacts/catalog/current.db there, or rename ` +
        `resources/lake-out/public/db/shruti.*.db into fixtures/content.db.`
    )
  }

  const fakeConfig = JSON.stringify({
    databases: [{ version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) }],
    // Master kill switch for the proactive subsystem (useProactiveScheduler) —
    // without it the scheduler ticks on boot, generates an "enable reminder"
    // session from the seeded activity, and drops a "Sadhu has a new message"
    // banner on top of the discovery / home screenshots.
    proactive: { master_enabled: false },
  })
  await page.route("**/public/config.json", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: fakeConfig })
  })

  const dbBytes = fs.readFileSync(CONTENT_DB_PATH)
  await page.route("**/public/db/shruti.*.db", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: dbBytes,
    })
  })

  // Transcript JSONs go straight to S3 — no intercept. Same URL the live
  // app hits at runtime, so we don't have to mirror them anywhere.

  // Audio MP3 fetches — the playlist's prefetch loop downloads every
  // track on mount; without this stub it hits real S3, fails, and
  // leaves the row pinned in `state="downloading"` which dims the
  // entire Up Next list with opacity 0.65 (`.playlist-row.is-disabled`).
  // A 1-byte stub is enough: the download store only checks success +
  // saves a localUrl reference; the player never actually plays in
  // capture mode.
  const STUB_MP3 = Buffer.alloc(1)
  await page.route("**/public/tracks/*/audio/*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      headers: { "content-length": "1" },
      body: STUB_MP3,
    })
  })

  // Media remembrance clip (`07_media`). The MediaCard's `<video>` shows
  // the `.jpg` poster until playback begins, so the poster is all the
  // screenshot needs — serve it from the committed fixture and stub the
  // `.mp4` itself (it never plays in capture). Same `public/media/<id>.*`
  // path the live app resolves from the active CDN.
  if (!fs.existsSync(MEDIA_POSTER_PATH)) {
    throw new Error(
      `Missing ${MEDIA_POSTER_PATH}.\n` +
        `Copy a clip poster there, e.g.:\n  cp resources/following-prabhupada/` +
        `build/dvd07/clips/ru/068_068.jpg fixtures/media/remembrance-poster.jpg`
    )
  }
  const posterBytes = fs.readFileSync(MEDIA_POSTER_PATH)
  await page.route("**/public/media/*.jpg", (route) => {
    route.fulfill({ status: 200, contentType: "image/jpeg", body: posterBytes })
  })
  const STUB_MP4 = Buffer.alloc(1)
  await page.route("**/public/media/*.mp4", (route) => {
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: { "content-length": "1" },
      body: STUB_MP4,
    })
  })

  // Transcript JSON (`04_transcript` scenario). Served from a committed fixture
  // instead of real S3 — the live fetch is slow/flaky and times out the
  // `.highlighted` / `.current` wait. Same doc seedNotes anchors the bookmarks
  // to, so the highlights line up. `fixtures/transcripts/<id>/<lang>.json`.
  // The playlist prefetch loop downloads EVERY track's transcript; the demo
  // track has a fixture, the rest get an empty stub so the prefetch resolves
  // fast instead of hammering (and 404-ing on) the real CDN.
  await page.route("**/public/tracks/*/transcripts/*.json", (route, req) => {
    const m = req.url().match(/\/public\/tracks\/([^/]+)\/transcripts\/([^/?]+\.json)/)
    const file = m ? path.join(FIXTURES_DIR, "transcripts", m[1], m[2]) : null
    const body = file && fs.existsSync(file) ? fs.readFileSync(file) : '{"version":1,"blocks":[]}'
    route.fulfill({ status: 200, contentType: "application/json", body })
  })
}

/* ---------------------- IndexedDB pre-seed ------------------------- */

/**
 * Pre-seed the search filter so the Library scenario shows Bhagavad-gita
 * lectures filtered + sorted by reference. Capacitor Preferences on web
 * stores values in `localStorage` under the `CapacitorStorage.` prefix.
 * Same source ID for both locales — `sources.id` is shared, only the
 * localized name row varies by `language`.
 */
async function preseedSearchFilter(page: Page, code: CaptureLocale): Promise<void> {
  const BG_SOURCE_ID = "source_dsicuBsFvinZ"
  const filters = {
    authorIds: [],
    // Filter by the CONTENT language (en/ru), not the UI locale — a UI locale
    // without its own audio still shows a populated library.
    languageCodes: [contentLanguageFor(code)],
    locationIds: [],
    sourceIds: [BG_SOURCE_ID],
    tagIds: [],
    duration: [],
    sort: "byReference",
  }
  await page.addInitScript(
    ({ value }: { value: string }) => {
      try {
        localStorage.setItem("CapacitorStorage.search.filters.v3", value)
      } catch {
        // unavailable origin — non-fatal, the scenario falls back to "no filter"
      }
    },
    { value: JSON.stringify(filters) }
  )
}

/**
 * Park the Home "enable reminders" notifications nag in its 14-day cooldown so
 * it doesn't dominate the Home screenshot. `useConfig` binds to Capacitor
 * Preferences (web → `localStorage` under the `CapacitorStorage.` prefix), so
 * stamping `home.notificationsNag.dismissedAt` to "just now" makes
 * `showNotificationsNag` evaluate false on first paint.
 */
async function preseedDismissedNags(page: Page): Promise<void> {
  await page.addInitScript(
    ({ value }: { value: string }) => {
      try {
        localStorage.setItem("CapacitorStorage.home.notificationsNag.dismissedAt", value)
      } catch {
        // unavailable origin — non-fatal, the banner just shows.
      }
    },
    { value: JSON.stringify(Date.now()) }
  )
}

/**
 * Mark onboarding complete so `start()` (main.ts) routes straight to
 * `/tabs/home`. Without it the app falls back to `/onboarding`: the flag
 * lives in Capacitor Preferences (web → `localStorage["CapacitorStorage.
 * onboarding.completed"]`), NOT the seeded user.db, and the history-based
 * fallback (`listeningSessions.hasAny()`) races the content-DB open and
 * throws ("content DB is not open yet"). Seeding the flag makes the
 * capture behave like a returning, onboarded user — deterministically.
 */
async function preseedOnboarding(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("CapacitorStorage.onboarding.completed", "true")
    } catch {
      // unavailable origin — non-fatal; the app falls back to /onboarding.
    }
  })
}

/**
 * Write the seeded user.db into IndexedDB BEFORE the app boots. The Vite
 * `useSqlJsPersistence` reads from `(shruti, databases, user.db)` on
 * `open()` and creates an empty DB only when the key is missing — so a
 * pre-seeded blob is picked up transparently and migrations no-op.
 */
async function preseedUserDb(page: Page, code: CaptureLocale): Promise<void> {
  const fixturePath = path.resolve(FIXTURES_DIR, `user-${code}.db`)
  if (!fs.existsSync(fixturePath)) {
    throw new Error(
      `Missing ${fixturePath}. Run from the tool root:\n  npm run generate-user-fixture`
    )
  }
  const bytes = fs.readFileSync(fixturePath)
  const base64 = bytes.toString("base64")

  await page.addInitScript(
    ({ b64 }: { b64: string }) => {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const req = indexedDB.open("shruti", 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore("databases")
      }
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

/* ------------------------- animations off -------------------------- */

const KILL_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-duration: 0ms !important;
    animation-delay: 0ms !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
  }
`

/* ------------------------------ boot ------------------------------- */

async function boot(page: Page, code: CaptureLocale): Promise<void> {
  await interceptContent(page)
  await preseedUserDb(page, code)
  await preseedSearchFilter(page, code)
  await preseedDismissedNags(page)
  await preseedOnboarding(page)

  await page.goto(`/?locale=${code}`)
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.__shruti?.debug), null, { timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}

/* --------------------------- navigation ---------------------------- */

async function navigateToRoute(page: Page, route: Scenario["route"]): Promise<void> {
  const url = page.url()
  if (url.endsWith(route) || url.includes(`${route}?`)) return
  await page.evaluate((t) => window.__shruti!.debug!.navigateTo(t), route)
  await page.waitForURL(`**${route}`, { timeout: 10_000 })
}

/* --------------------------- the spec ------------------------------ */

for (const scenario of scenarios) {
  test(`capture ${scenario.name}`, async ({ page }, testInfo) => {
    const { code, device } = projectInfo(testInfo.project.name)
    const outPath = path.resolve(
      TOOL_ROOT,
      `out/raw/${device}-${code}/${scenario.name}.png`
    )
    fs.mkdirSync(path.dirname(outPath), { recursive: true })

    await boot(page, code)
    await navigateToRoute(page, scenario.route)

    if (scenario.beforeCapture) {
      await scenario.beforeCapture(page, code)
    }

    await page.locator(scenario.waitFor).first().waitFor({ state: "visible", timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)
    if (scenario.settle) await page.waitForTimeout(scenario.settle)

    await page.screenshot({ path: outPath, fullPage: false })
    console.log(`  → ${path.relative(REPO_ROOT, outPath)}`)
  })
}
