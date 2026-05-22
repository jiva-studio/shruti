import { test, type Page } from "@playwright/test"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { scenarios, type Scenario } from "../scenarios.js"
import { verseBodyCache } from "../generate-fixtures/chat.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(__dirname, "..")
const REPO_ROOT = path.resolve(TOOL_ROOT, "../../..")
const FIXTURES_DIR = path.resolve(TOOL_ROOT, "fixtures")

const CONTENT_DB_PATH = path.resolve(FIXTURES_DIR, "content.db")

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

type Device = "phone" | "iphone67" | "ipad13"

interface ProjectInfo {
  code: "en" | "ru"
  device: Device
}

function projectInfo(name: string): ProjectInfo {
  const [device, code] = name.split("-") as [Device, "en" | "ru"]
  return { device, code }
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
 * Pre-seed the verse-body cache so the chat scenario's `[verse:…]`
 * markers render as full sanskrit + IAST + translation blocks rather
 * than chip placeholders. The live app populates this cache from the
 * server's `verse_payload` SSE event the first time a verse is cited;
 * with no real chat server in the capture run we have to seed it
 * directly. Same `CapacitorStorage.` localStorage prefix as the search
 * filter preseed, same `STORAGE_KEY` (`lectorium.verse_body_cache.v1`)
 * the store reads at hydrate time.
 */
async function preseedVerseBodyCache(page: Page): Promise<void> {
  const now = Date.now()
  const serialised: Record<string, unknown> = {}
  for (const [key, body] of Object.entries(verseBodyCache)) {
    serialised[key] = { ...body, touchedAt: now }
  }
  await page.addInitScript(
    ({ value }: { value: string }) => {
      try {
        localStorage.setItem("CapacitorStorage.lectorium.verse_body_cache.v1", value)
      } catch {
        // unavailable origin — non-fatal, the VerseCard falls back to
        // its inline chip placeholder.
      }
    },
    { value: JSON.stringify(serialised) }
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
  await preseedVerseBodyCache(page)

  await page.goto(`/?locale=${code}`)
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.waitForFunction(() => Boolean(window.__lectorium?.debug), null, { timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}

/* --------------------------- navigation ---------------------------- */

async function navigateToRoute(page: Page, route: Scenario["route"]): Promise<void> {
  const url = page.url()
  if (url.endsWith(route) || url.includes(`${route}?`)) return
  await page.evaluate((t) => window.__lectorium!.debug!.navigateTo(t), route)
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
      await scenario.beforeCapture(page)
    }

    await page.locator(scenario.waitFor).first().waitFor({ state: "visible", timeout: 30_000 })
    await page.evaluate(() => document.fonts.ready)
    if (scenario.settle) await page.waitForTimeout(scenario.settle)

    await page.screenshot({ path: outPath, fullPage: false })
    console.log(`  → ${path.relative(REPO_ROOT, outPath)}`)
  })
}
