import { defineConfig } from "@playwright/test"
import { execSync } from "child_process"
import { CAPTURE_LOCALES, DEVICES, localeTag, projectName } from "./config.js"

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

/**
 * Android phone target for Play Store: CSS 412×892 × DPR 3 → 1236×2676 PNG
 * (modern Android flagship, matches Play Console `phoneScreenshots` rule).
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 90_000,
  // Capturing 32 scenarios (8 × iphone67/ipad13 × en/ru) on a shared CI runner,
  // a single scenario occasionally times out waiting for its state (e.g. the
  // transcript dialog's .highlighted/.current). Without retries that one flake
  // fails the whole deploy. Retry in CI so a transient capture re-runs instead.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    // Dedicated port (NOT the app's usual 11001) so a worktree dev server left
    // running on 11001 can't be silently reused — that server lacks
    // VITE_DEBUG_API=true, so the debug bridge never installs and every
    // scenario times out at boot. `--port` here overrides the script's default.
    command: "cd ../../apps/mobile && npm run dev:screenshots -- --port 11099",
    port: 11099,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  use: {
    baseURL: "http://localhost:11099",
    launchOptions: { executablePath: findChrome() },
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 3,
    colorScheme: "light",
    headless: true,
  },
  // One project per (device × locale), generated from config.ts. Device sizes:
  //   phone      412×892  ×3   → 1236×2676 (Play phoneScreenshots)
  //   iphone67   430×932  ×3   → 1290×2796 (App Store 6.7")
  //   ipad13    1024×1366 ×2   → 2048×2732 (App Store iPad 13")
  //   surfaceduo 540×720  ×2.5 → 1350×1800 (Play large-screen)
  projects: DEVICES.flatMap((d) =>
    CAPTURE_LOCALES.map((code) => ({
      name: projectName(d.code, code),
      use: {
        locale: localeTag(code),
        viewport: { width: d.width, height: d.height },
        deviceScaleFactor: d.dpr,
      },
    }))
  ),
})
