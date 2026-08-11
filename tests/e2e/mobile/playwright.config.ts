import { defineConfig } from "@playwright/test"
import { execSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import { createHash } from "crypto"
import { fileURLToPath } from "url"

// Load a gitignored .env.local into process.env so secrets persist across runs
// instead of living in a shell that's gone next time: QASE_TESTOPS_API_TOKEN for
// result publishing, OPENROUTER_API_KEY / AWS_* for @live. An already-set env var
// wins, so an inline `VAR=… playwright test` override still takes precedence.
;(() => {
  const envFile = fileURLToPath(new URL(".env.local", import.meta.url))
  if (!existsSync(envFile)) return
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let val = m[2]
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
})()

/**
 * One config, two projects so a single run produces ONE report:
 *   - `offline` — deterministic, fixture-backed (intercepts), no backend. `@offline`.
 *   - `live`    — real local stack (chat + auth) via VITE_DEV_REGION. `@live`.
 *
 * The live dev server + project are only added when E2E_INCLUDE_LIVE is set, so
 * the default `npm test` (offline) stays fast and CI-safe. `npm run test:all`
 * sets it and runs both into the same playwright-report/.
 */
/**
 * One port per checkout, derived from this file's own path.
 *
 * A fixed port plus `reuseExistingServer` means the second checkout to start a
 * run does not start a server — it silently attaches to the FIRST one, and
 * then tests that other tree's code while reporting against this one's specs.
 * Two agents lost time to false red runs that way (#1671); the dangerous
 * direction is the quiet one, where a spec passes against a sibling's
 * not-yet-broken build.
 *
 * The derivation is stable, so a repeated run in the same checkout still
 * reuses its own server — which is the convenience the fixed port was for.
 * `E2E_PORT` still wins; CI sets it explicitly.
 */
function portForCheckout(): number {
  const digest = createHash("sha1").update(fileURLToPath(import.meta.url)).digest()
  // 11100..11999 — above the suite's own reserved 11097 and clear of the local
  // stack (11080/11081) and the screenshot pipeline (11099).
  return 11100 + (digest.readUInt16BE(0) % 900)
}

const PORT = Number(process.env.E2E_PORT ?? portForCheckout())
// The live app must be served from an origin the chat service's CORS allows
// (CORS_ALLOW_ORIGINS in .env.dev: 8080 / 11001). An arbitrary port gets its
// preflight rejected (400) and the chat POST is silently blocked → answers hang
// on "Thinking…". 8080 is whitelisted and usually free (11001 is the app's own
// dev port). Override with E2E_LIVE_PORT if your CORS list differs.
const LIVE_PORT = Number(process.env.E2E_LIVE_PORT ?? 8080)
const USE_BUNDLE = process.env.E2E_USE_BUNDLE === "1"
const INCLUDE_LIVE = process.env.E2E_INCLUDE_LIVE === "1"

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  if (process.env.CI) return undefined
  try {
    return execSync("which google-chrome-stable || which chromium || which google-chrome", {
      encoding: "utf-8",
    }).trim()
  } catch {
    return undefined
  }
}

// `SHRUTI_E2E_BUILD=1` is what makes `boot({ pro: true })` mean anything:
// the app honours the subscription override only on a build that opted in at
// compile time (see modules/apps/mobile/shruti/services/devSubscription.ts).
// The dev server gets it here; the bundle has to be BUILT with it
// (`npm run build:bundle`), which globalSetup checks before the run starts.
const offlineCommand = USE_BUNDLE
  ? `node scripts/serve-dist.mjs ../../../modules/apps/mobile/dist ${PORT}`
  : `cd ../../../modules/apps/mobile && SHRUTI_E2E_BUILD=1 npm run dev -- --port ${PORT} --strictPort`
const liveCommand = `cd ../../../modules/apps/mobile && VITE_DEV_REGION=true SHRUTI_E2E_BUILD=1 npm run dev -- --port ${LIVE_PORT} --strictPort`

const QASE = process.env.QASE_MODE === "testops"

const sharedUse = {
  launchOptions: { executablePath: findChrome() },
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 2,
  colorScheme: "light" as const,
  headless: true,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  // Record a video of every test so the run can be reviewed visually in the
  // local HTML report. In Qase mode we drop to failure-only video: with
  // uploadAttachments on, a video per passing test would blow the Free plan's
  // 500 Mb storage in a couple of runs (set QASE_VIDEO_ALL=1 to force all).
  video: (QASE && process.env.QASE_VIDEO_ALL !== "1"
    ? "retain-on-failure"
    : "on") as "on" | "retain-on-failure",
}

export default defineConfig({
  testDir: "./tests",
  // Pull / refresh the gitignored binary fixtures before the run so the suite
  // never uses a missing or stale catalog snapshot (see support/globalSetup.ts).
  globalSetup: "./support/globalSetup.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // The Qase reporter is always present but a no-op unless QASE_MODE=testops.
  // To push results INTO an existing run (created from a Qase test plan) without
  // closing it, run with:
  //   QASE_MODE=testops QASE_TESTOPS_API_TOKEN=… QASE_TESTOPS_RUN_ID=<id> npm run test:qase
  // run.complete stays false (override with QASE_TESTOPS_RUN_COMPLETE=true) so the
  // run stays open for the remaining manual cases. Tests link to cases via the
  // qase(<id>, "title") wrapper in each spec.
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    [
      "playwright-qase-reporter",
      {
        mode: process.env.QASE_MODE || "off",
        testops: {
          api: { token: process.env.QASE_TESTOPS_API_TOKEN },
          project: process.env.QASE_TESTOPS_PROJECT || "SHRUTI",
          run: { complete: process.env.QASE_TESTOPS_RUN_COMPLETE === "true" },
          // Upload Playwright artifacts (screenshot / video / trace) to each Qase
          // result so a case can be opened in the run and inspected visually.
          uploadAttachments: true,
        },
      },
    ],
  ],
  webServer: [
    { command: offlineCommand, port: PORT, reuseExistingServer: !process.env.CI, timeout: 120_000 },
    ...(INCLUDE_LIVE
      ? [
          {
            command: liveCommand,
            port: LIVE_PORT,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
      : []),
  ],
  // Project names are deliberately NOT "offline"/"live" — those are the tags, and
  // a project chip equal to the tag chip shows up doubled in the HTML report.
  projects: [
    {
      name: "mocked",
      grep: /@offline/,
      use: { ...sharedUse, baseURL: `http://localhost:${PORT}` },
    },
    ...(INCLUDE_LIVE
      ? [
          {
            name: "stack",
            grep: /@live/,
            use: { ...sharedUse, baseURL: `http://localhost:${LIVE_PORT}` },
          },
        ]
      : []),
  ],
})
