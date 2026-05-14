import { test, type Page } from "@playwright/test"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { scenarios, type Scenario } from "../scenarios.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(__dirname, "..")
const REPO_ROOT = path.resolve(TOOL_ROOT, "../../..")
const FIXTURES_DIR = path.resolve(TOOL_ROOT, "fixtures")

const CONTENT_DB_PATH = path.resolve(FIXTURES_DIR, "content.db")
const CONTENT_DB_VERSION = 20260512121125
// Local mirror of the S3 bucket root — `resources/lake-out/` holds a
// snapshot of every published path the app might fetch (`public/db/...`,
// `public/tracks/...`). We serve transcripts from here so scenario
// `04_transcript` can render `.current` / `.highlighted` without
// S3 reachability. URLs are full bucket keys (start with `public/`),
// so PUBLIC_ASSETS_ROOT is the bucket root, not the `public/` subdir.
// Path: modules/tools/screenshots/specs → up to workspace root → resources/lake-out.
const PUBLIC_ASSETS_ROOT = path.resolve(
  __dirname,
  "../../../../../..",
  "resources/lake-out"
)

interface ProjectInfo {
  code: "en" | "ru"
  device: "phone"
}

function projectInfo(name: string): ProjectInfo {
  return { code: name.endsWith("-ru") ? "ru" : "en", device: "phone" }
}

/* ---------------------- network interception ----------------------- */

/**
 * Intercept the only two network calls Welcome needs:
 *  - `**​/public/config.json`        → fake manifest pointing at our content.db version
 *  - `**​/public/db/lectorium.*.db`  → bytes from local fixtures/content.db
 *
 * Both real CDNs (S3, Yandex Cloud) and any localhost proxy match the
 * `**​/public/…` glob.
 */
async function interceptContent(page: Page): Promise<void> {
  if (!fs.existsSync(CONTENT_DB_PATH)) {
    throw new Error(
      `Missing ${CONTENT_DB_PATH}.\n` +
        `Copy resources/lake-out/artifacts/catalog/current.db there, or rename ` +
        `resources/lake-out/public/db/lectorium.*.db into fixtures/content.db.`
    )
  }

  const fakeConfig = JSON.stringify({
    databases: [{ version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) }],
  })
  await page.route("**/public/config.json", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: fakeConfig })
  })

  const dbBytes = fs.readFileSync(CONTENT_DB_PATH)
  await page.route("**/public/db/lectorium.*.db", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: dbBytes,
    })
  })

  // Transcript JSONs — served from resources/lake-out/public/tracks/...
  // so the dialog can render real blocks without S3 reachability.
  await page.route("**/public/tracks/*/transcripts/*.json", (route) => {
    const url = new URL(route.request().url())
    const localPath = path.join(PUBLIC_ASSETS_ROOT, url.pathname.replace(/^\/+/, ""))
    if (!fs.existsSync(localPath)) {
      return route.fulfill({ status: 404, body: "" })
    }
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: fs.readFileSync(localPath),
    })
  })

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
}

/* ---------------------- IndexedDB pre-seed ------------------------- */

/**
 * Pre-seed the search filter so the Library scenario shows Bhagavad-gita
 * lectures filtered + sorted by reference. Capacitor Preferences on web
 * stores values in `localStorage` under the `CapacitorStorage.` prefix.
 * Same source ID for both locales — `sources.id` is shared, only the
 * localized name row varies by `language`.
 */
async function preseedSearchFilter(page: Page, code: "en" | "ru"): Promise<void> {
  const BG_SOURCE_ID = "source_dsicuBsFvinZ"
  const filters = {
    authorIds: [],
    languageCodes: [code],
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
 * Write the seeded user.db into IndexedDB BEFORE the app boots. The Vite
 * `useSqlJsPersistence` reads from `(lectorium, databases, user.db)` on
 * `open()` and creates an empty DB only when the key is missing — so a
 * pre-seeded blob is picked up transparently and migrations no-op.
 */
async function preseedUserDb(page: Page, code: "en" | "ru"): Promise<void> {
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
      const req = indexedDB.open("lectorium", 1)
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

async function boot(page: Page, code: "en" | "ru"): Promise<void> {
  await interceptContent(page)
  await preseedUserDb(page, code)
  await preseedSearchFilter(page, code)

  await page.goto(`/?locale=${code}`)
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.__lectorium?.debug), null, { timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}

/* --------------------------- navigation ---------------------------- */

const TAB_PATHS: Record<Scenario["route"], string> = {
  "/tabs/home": "/tabs/home",
  "/tabs/search": "/tabs/search",
  "/tabs/notes": "/tabs/notes",
}

async function navigateToRoute(page: Page, route: Scenario["route"]): Promise<void> {
  const target = TAB_PATHS[route]
  const url = page.url()
  if (url.endsWith(target) || url.includes(`${target}?`)) return
  await page.evaluate((t) => window.__lectorium!.debug!.navigateTo(t), target)
  await page.waitForURL(`**${target}`, { timeout: 10_000 })
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
      await scenario.beforeCapture(page)
    }

    await page.locator(scenario.waitFor).first().waitFor({ state: "visible", timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)
    if (scenario.settle) await page.waitForTimeout(scenario.settle)

    await page.screenshot({ path: outPath, fullPage: false })
    console.log(`  → ${path.relative(REPO_ROOT, outPath)}`)
  })
}
