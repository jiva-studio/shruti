import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"

const MOCK = fileURLToPath(new URL("../../tools/mock-server/server.mjs", import.meta.url))
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 11090)
let mock: ChildProcess | undefined

const APK = fileURLToPath(
  new URL(
    "../../../modules/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
    import.meta.url,
  ),
)

if (!existsSync(APK)) {
  throw new Error(`No APK at ${APK} — build it first (mobile-emulator-run skill).`)
}

const UDID = process.env.ANDROID_SERIAL ?? "emulator-5556"

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,

  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": UDID,
      "appium:app": APK,
      "appium:appPackage": "studio.jiva.shruti",
      "appium:appActivity": ".MainActivity",
      // Every run starts from first-launch state, or the onboarding gate is off.
      "appium:fullReset": true,
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 120,
    },
  ],

  // APPIUM_PORT drives an already-running server instead of spawning one.
  port: Number(process.env.APPIUM_PORT ?? 4723),
  services: process.env.APPIUM_PORT
    ? []
    // A STRING, not an array: the service JSON-stringifies a non-string value,
    // so an array arrives as `--allow-insecure ["uiautomator2:…"]` and Appium
    // never recognises the feature. The WebView context then fails with
    // "No Chromedriver found", which reads like the nix-ld load failure and is
    // not one.
    : [["appium", { args: { allowInsecure: "uiautomator2:chromedriver_autodownload" } }]],

  // The APK is built against the mock (VITE_DEV_REGION), reached through
  // `adb reverse` so the same localhost URL works on a phone too.
  onPrepare: () => {
    mock = spawn(process.execPath, [MOCK], { stdio: "inherit" })
    execFileSync("adb", ["-s", UDID, "reverse", `tcp:${MOCK_PORT}`, `tcp:${MOCK_PORT}`])
  },
  onComplete: () => {
    mock?.kill()
    try {
      execFileSync("adb", ["-s", UDID, "reverse", "--remove", `tcp:${MOCK_PORT}`])
    } catch {
      // the device may already be gone
    }
  },

  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 30_000,
  mochaOpts: { ui: "bdd", timeout: 180_000 },
}
