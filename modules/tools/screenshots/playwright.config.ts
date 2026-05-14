import { defineConfig } from "@playwright/test"
import { execSync } from "child_process"

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
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    command: "cd ../../apps/mobile && npm run dev:screenshots",
    port: 11001,
    reuseExistingServer: !process.env.CI,
    timeout: 90_000,
  },
  use: {
    baseURL: "http://localhost:11001",
    launchOptions: { executablePath: findChrome() },
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 3,
    colorScheme: "light",
    headless: true,
  },
  projects: [
    // Android phone: 412×892 × DPR 3 → 1236×2676 PNG (Play `phoneScreenshots`).
    { name: "phone-en", use: { locale: "en-US" } },
    { name: "phone-ru", use: { locale: "ru-RU" } },
    // iPhone 6.7": 430×932 × DPR 3 → 1290×2796 PNG (App Store iPhone 6.7").
    {
      name: "iphone67-en",
      use: { locale: "en-US", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
    },
    {
      name: "iphone67-ru",
      use: { locale: "ru-RU", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
    },
    // iPad Pro 13": 1024×1366 × DPR 2 → 2048×2732 PNG (App Store iPad 13").
    {
      name: "ipad13-en",
      use: { locale: "en-US", viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2 },
    },
    {
      name: "ipad13-ru",
      use: { locale: "ru-RU", viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2 },
    },
  ],
})
