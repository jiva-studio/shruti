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
  type UserDbStrategy,
} from "./fixtures.js"
import { requireFixtures } from "./test.js"

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
 *     `window.__lectorium.debug`. The CI bundle has no debug bridge, so the
 *     suite must never depend on it.
 */

/* ---------------------- network interception ----------------------- */

/**
 * Intercept the only calls Welcome needs to come up offline + deterministically:
 *  - **​/public/config.json        → a fake manifest pinned to our content.db.
 *  - **​/public/db/lectorium.*.db   → bytes from fixtures/content.db.
 *  - **​/public/tracks/*​/audio/*    → the silent MP3 stub (valid, so playback works).
 *  - **​/public/tracks/*​/transcripts/*.json → a fixture transcript (trackId patched
 *    to match the request) so the reader renders offline + deterministically.
 */
export async function interceptContent(page: Page): Promise<void> {
  requireFixtures()
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
  await page.route("**/public/db/lectorium.*.db", (route) => {
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
 * `useSqlJsPersistence` reads `(lectorium, databases, user.db)` on open() and
 * only creates an empty DB when the key is missing, so a pre-seeded blob is
 * picked up transparently and migrations no-op. The default `preseed` fixture
 * carries ~9 playlist tracks, listening history and notes; the `clean` strategy
 * loads a schema+config-only db so specs that bring their own state show an
 * empty home (see screenshots/generate-fixtures).
 */
export async function preseedUserDb(
  page: Page,
  locale: Locale,
  strategy: UserDbStrategy = "preseed"
): Promise<void> {
  const base64 = fs.readFileSync(userDbPath(locale, strategy)).toString("base64")
  await page.addInitScript(
    ({ b64 }: { b64: string }) => {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const req = indexedDB.open("lectorium", 1)
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
 * Like {@link preseedUserDb} but seeds ONLY when the user DB isn't already in
 * IndexedDB. Use this for restart/persistence tests: the unconditional preseed
 * re-runs on every reload and would clobber any runtime-written rows (e.g. a
 * completed download), so a "restart" wouldn't represent real persistence.
 */
export async function preseedUserDbOnce(page: Page, locale: Locale): Promise<void> {
  const base64 = fs.readFileSync(userDbPath(locale)).toString("base64")
  await page.addInitScript(
    ({ b64 }: { b64: string }) => {
      const open = indexedDB.open("lectorium", 1)
      open.onupgradeneeded = () => open.result.createObjectStore("databases")
      open.onsuccess = () => {
        const db = open.result
        const ro = db.transaction(["databases"], "readonly").objectStore("databases").get("user.db")
        ro.onsuccess = () => {
          if (ro.result) {
            db.close()
            return
          }
          const bin = atob(b64)
          const arr = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
          const tx = db.transaction(["databases"], "readwrite")
          tx.objectStore("databases").put(arr, "user.db")
          tx.oncomplete = () => db.close()
        }
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
export async function preseedSearchFilter(
  page: Page,
  locale: Locale,
  sourceIds: string[] = ["source_dsicuBsFvinZ"]
): Promise<void> {
  const filters = {
    authorIds: [],
    languageCodes: [locale],
    locationIds: [],
    // Empty → no source constraint (full catalog). Defaults to the
    // Bhagavad-gita source for a stable, reference-sorted list.
    sourceIds,
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

/** Park the Home nags (reminders + subscription) in their cooldown so they can't
 *  cover rows. The subscription nag only shows for non-Pro users, which is now
 *  the e2e default — so dismiss both. */
export async function preseedDismissedNags(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      const far = JSON.stringify(2_000_000_000_000)
      localStorage.setItem("CapacitorStorage.home.notificationsNag.dismissedAt", far)
      localStorage.setItem("CapacitorStorage.home.subscriptionNag.dismissedAt", far)
    } catch {
      /* non-fatal */
    }
  })
}

/**
 * Force the app to run as a NON-subscribed (free) user. The dev build treats
 * everyone as Pro (see usePurchasesStore); this flag defeats that override so
 * paywalls and Pro gates are reproducible. It can never grant Pro and is inert
 * on production builds.
 */
export async function preseedNonPro(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("CapacitorStorage.e2e.forceFreeTier", "1")
    } catch {
      /* non-fatal */
    }
  })
}

/**
 * Seed a signed-in (non-anonymous) auth session so account / sign-out specs run
 * without a real backend. The token expires a year out, so the app never tries
 * to refresh (no `/auth/me` round-trip) and stays signed in offline. Call BEFORE
 * boot(). The JWT's base64 middle carries `exp`/`tier`/`quota_id` claims.
 */
export async function preseedAuthTokens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const exp = Math.floor(Date.now() / 1000) + 3600 * 24 * 365
    const claims = btoa(JSON.stringify({ exp, tier: "free", quota_id: "q1" }))
    const tokens = {
      accessToken: `h.${claims}.s`,
      refreshToken: "e2e-refresh",
      email: "e2e@example.com",
      name: "E2E Tester",
      anonymous: false,
      accessTokenExpiresAt: exp * 1000,
    }
    try {
      localStorage.setItem("CapacitorStorage.auth.tokens", JSON.stringify(tokens))
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
  opts: { dismissNags?: boolean; sourceIds?: string[]; pro?: boolean; userDb?: UserDbStrategy } = {}
): Promise<void> {
  const { dismissNags = true, pro = false, userDb = "preseed" } = opts
  assertFixturesPresent()
  await interceptContent(page)
  await preseedUserDb(page, locale, userDb)
  await preseedSearchFilter(page, locale, opts.sourceIds)
  if (dismissNags) await preseedDismissedNags(page)
  // The dev build treats every user as Pro. For the e2e suite we flip that:
  // boot NON-Pro by default (so paywalls / Pro gates are reproducible) and
  // turn Pro on explicitly with `boot(page, locale, { pro: true })`.
  if (!pro) await preseedNonPro(page)

  await page.goto(`/?locale=${locale}`)
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}

/**
 * Persist a library-language filter with an explicit set of content languages
 * (e.g. `["ru", "en"]` to exercise the multi-select). Pins the Bhagavad-gita
 * source — which carries both en and ru lectures — so the resulting list is
 * stable and populated. Distinct from {@link preseedSearchFilter}, which seeds a
 * single locale.
 */
export async function preseedSearchFilterLangs(page: Page, langs: string[]): Promise<void> {
  const filters = {
    authorIds: [],
    languageCodes: langs,
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

/**
 * Boot WITHOUT a pre-seeded language filter, so the app runs its real first-
 * launch library-language derivation from the device locale (`uk → ru`, `hi →
 * en`, …). Set the device/browser locale with Playwright's `test.use({ locale })`
 * — on web `Device.getLanguageCode()` reads `navigator.language`, which the
 * `locale` context option drives. `userDb` chooses which seeded user.db to load
 * (use the language the locale reduces to). Pass `filterLangs` to instead pin an
 * explicit multi-language selection (skips derivation).
 */
export async function bootDeviceLocale(
  page: Page,
  userDb: Locale = "en",
  opts: { filterLangs?: string[]; userDbStrategy?: UserDbStrategy } = {}
): Promise<void> {
  assertFixturesPresent()
  await interceptContent(page)
  await preseedUserDb(page, userDb, opts.userDbStrategy ?? "preseed")
  if (opts.filterLangs) await preseedSearchFilterLangs(page, opts.filterLangs)
  await preseedDismissedNags(page)

  // No `?locale=` override: detectLocale()/Device.getLanguageCode() fall through
  // to navigator.language, set by the Playwright `locale` context option.
  await page.goto("/")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })
  await page.locator("ion-tab-bar").first().waitFor({ state: "visible", timeout: 30_000 })
  await page.addStyleTag({ content: KILL_ANIMATIONS_CSS })
}
