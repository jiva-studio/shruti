import { defineConfig } from "@playwright/test"
import { execSync } from "child_process"

/**
 * One config, two projects so a single run produces ONE report:
 *   - `offline` — deterministic, fixture-backed (intercepts), no backend. `@offline`.
 *   - `live`    — real local stack (chat + auth) via VITE_DEV_REGION. `@live`.
 *
 * The live dev server + project are only added when E2E_INCLUDE_LIVE is set, so
 * the default `npm test` (offline) stays fast and CI-safe. `npm run test:all`
 * sets it and runs both into the same playwright-report/.
 */
const PORT = Number(process.env.E2E_PORT ?? 11097)
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

const offlineCommand = USE_BUNDLE
  ? `node scripts/serve-dist.mjs ../../../modules/apps/mobile/dist ${PORT}`
  : `cd ../../../modules/apps/mobile && npm run dev -- --port ${PORT} --strictPort`
const liveCommand = `cd ../../../modules/apps/mobile && VITE_DEV_REGION=true npm run dev -- --port ${LIVE_PORT} --strictPort`

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
