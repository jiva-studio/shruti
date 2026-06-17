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
  ? `node scripts/serve-dist.mjs ../../apps/mobile/dist ${PORT}`
  : `cd ../../apps/mobile && npm run dev -- --port ${PORT} --strictPort`
const liveCommand = `cd ../../apps/mobile && VITE_DEV_REGION=true npm run dev -- --port ${LIVE_PORT} --strictPort`

const sharedUse = {
  launchOptions: { executablePath: findChrome() },
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 2,
  colorScheme: "light" as const,
  headless: true,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
  // Record a video of every test so the run can be reviewed visually in the report.
  video: "on" as const,
}

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
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
