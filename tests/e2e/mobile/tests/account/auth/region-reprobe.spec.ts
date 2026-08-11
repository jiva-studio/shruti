import { test, expect } from "../../../support/test.js"
import { qase } from "playwright-qase-reporter"
import {
  interceptContent,
  preseedUserDb,
  preseedOnboardingDone,
  preseedSearchFilter,
  preseedDismissedNags,
} from "../../../support/bootstrap.js"
import { CONTENT_DB_VERSION } from "../../../support/fixtures.js"
import { step, caseTitle } from "../../../support/steps.js"

/**
 * The region has to follow the device, not the process.
 *
 * `probe()` used to be called from exactly one place — the cold-start
 * bootstrap. Nothing re-ran it, so a user who flew somewhere, toggled a VPN or
 * switched networks kept the region they booted with for as long as the process
 * lived, which on mobile is days. That is the entry condition for the auth
 * outage: API calls go to the wrong door with no cross-door replay, and the
 * media layer's own walk corrupts and persists the region.
 *
 * Here the app settles on edge-a, edge-a then goes away (the relocation), and
 * the app is resumed and reports itself back online. The persisted region must
 * move to edge-b without a restart.
 *
 * Distinct from case 190: that one keeps the region put and walks the doors for
 * a single auth call. This one is about the region selection itself.
 */
function region(id: string, host: string) {
  return {
    id,
    name: id,
    urlTemplate: `https://${host}/{path}`,
    shareAudioUrl: `https://${host}/share/audio/excerpts`,
    shareVideoUrl: `https://${host}/share/video/reels`,
    shareTranscriptUrl: `https://${host}/share/transcripts`,
    authBaseUrl: `https://${host}/auth`,
    chatBaseUrl: `https://${host}`,
    profileBaseUrl: `https://${host}`,
    orchestratorBaseUrl: `https://${host}`,
    discoveryBaseUrl: `https://${host}`,
  }
}

const REGIONS = [region("edge-a", "edge-a.test"), region("edge-b", "edge-b.test")]

const CONFIG_BODY = JSON.stringify({
  databases: [
    { version: CONTENT_DB_VERSION, scheme: Number(String(CONTENT_DB_VERSION).slice(0, 8)) },
  ],
  proactive: { master_enabled: false },
  regions: REGIONS,
})

/** The persisted region id — what the next cold start would boot on. */
async function preferredRegion(page: import("@playwright/test").Page): Promise<string | null> {
  return await page.evaluate(() => localStorage.getItem("CapacitorStorage.preferredServerId"))
}

test(qase(192, caseTitle(192)), { tag: ["@offline", "@account"] }, async ({ page }) => {
  await interceptContent(page)
  await preseedUserDb(page, "en", "clean")
  await preseedSearchFilter(page, "en")
  await preseedDismissedNags(page)
  await preseedOnboardingDone(page)

  // Start from a settled two-region state: the registry is already hydrated and
  // edge-a is the remembered choice, so the bootstrap probe asks edge-a first.
  await page.addInitScript(
    ({ regions }: { regions: unknown }) => {
      localStorage.setItem("CapacitorStorage.remoteRegions", JSON.stringify(regions))
      localStorage.setItem("CapacitorStorage.preferredServerId", "edge-a")
    },
    { regions: REGIONS }
  )

  // Both doors answer at boot. Registered after interceptContent so these win
  // for their hosts, while its catch-all still serves the DB and media.
  let edgeAUp = true
  await page.route("https://edge-a.test/public/config.json", (route) => {
    if (!edgeAUp) return route.abort("connectionrefused")
    return route.fulfill({ status: 200, contentType: "application/json", body: CONFIG_BODY })
  })
  await page.route("https://edge-b.test/public/config.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: CONFIG_BODY })
  )

  await page.goto("/?locale=en")
  await page.waitForURL("**/tabs/home", { timeout: 60_000 })

  await step(page, 192, 0, async () => {
    await expect.poll(() => preferredRegion(page), { timeout: 30_000 }).toBe("edge-a")
  })

  await step(page, 192, 1, async () => {
    // The relocation: the door the device booted on is no longer reachable.
    edgeAUp = false

    // What the OS delivers when the user comes back to the app on a network
    // that changed underneath it. The web `@capacitor/app` build turns a
    // visibilitychange pair into a real `appStateChange`, and the radio
    // re-attaching fires `online`.
    await page.evaluate(() => {
      const setHidden = (value: boolean): void => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value })
      }
      setHidden(true)
      document.dispatchEvent(new Event("visibilitychange"))
      setHidden(false)
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("online"))
    })

    // The probe is hedged, so the dead door costs a connect failure, not a
    // timeout — but give the walk room.
    await expect.poll(() => preferredRegion(page), { timeout: 30_000 }).not.toBe("edge-a")
  })

  await step(page, 192, 2, async () => {
    // Healed in place: the next cold start already begins on the live door,
    // instead of the region staying stale until the process happens to die.
    expect(await preferredRegion(page)).toBe("edge-b")
  })
})
