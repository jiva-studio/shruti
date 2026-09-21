import type { IPreferences } from "@ports/app/index.js"
import router from "@lectorium/router/index.js"
import { bootLocaleReady } from "@lectorium/i18n/index.js"
import { applyStoredAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { findRegion, hydrateRegions } from "@lectorium/services/regionsRegistry.js"
import { readPreferredServerId } from "@lectorium/services/preferredServer.js"
import { runStartupBootstrap } from "@lectorium/services/startup.js"
import { startRegionWatch } from "@lectorium/services/regionWatch.js"
import { resolveInitialRoute } from "@lectorium/services/startupRoute.js"
import { runPostMountWork } from "@lectorium/services/postMount.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"

// Headless startup, all before the first paint — there is NO loading screen.
// 1) Hydrate the region list from the last-persisted (downloaded) config so the
//    first CDN probe targets the latest regions, not the bundled seed.
// 2) Open the databases (the bundled DB makes this instant + offline on first
//    launch; cached on later launches). Failure is logged, not fatal.
// 3) Choose the initial route: first launch → onboarding, otherwise Home.
// The OS-native splash covers this brief, invisible work.
export async function runBootSequence(
  preferences: IPreferences,
  mountApp: () => void
): Promise<void> {
  // i18n boots on the DEVICE locale, which is not necessarily the one the user
  // picked in Settings. Kick the stored choice's chunk off first thing so it
  // downloads alongside everything below, and await it before the mount — the
  // first paint is then in the chosen language rather than flashing the device
  // one and swapping the whole screen a moment later.
  const uiLanguageReady = applyStoredAppLanguage(preferences)

  await hydrateRegions(preferences).catch((e) => {
    console.warn("[lectorium] region hydration failed; using bundled defaults", e)
  })

  // Seed the active region from the user's last explicit pick (Settings
  // server picker) BEFORE the bootstrap probe, so the probe tries it
  // first instead of always preferring the config's first region. A
  // stored id that no longer exists in the hydrated region list is
  // ignored — the probe falls back to the bundled default order.
  const preferredId = await readPreferredServerId(preferences)
  if (preferredId && findRegion(preferredId)) {
    useLectorium().setActiveServerById(preferredId)
  }

  const startup = await runStartupBootstrap()
  if (!startup.ready) {
    reportError("startup", new Error(startup.error ?? "content database failed to open"))
  }

  // The bootstrap probe above is the only one the app ever ran. Keep the region
  // following the device from here on — a relocation or a VPN flip must not
  // wait for the next cold start, which on mobile can be days away.
  startRegionWatch()

  // Settle the UI language before anything can read it. `resolveInitialRoute`
  // below reaches `repositories()`, which builds the shared `useAppLanguage`
  // ref — and that ref is seeded from whatever locale is live at the moment of
  // the first call, then hydrated asynchronously. Awaiting here costs nothing
  // in wall time (it was kicked off first thing, in parallel with the bootstrap
  // above, which is the slow part) and removes the last window in which a
  // consumer can read the device locale instead of the chosen one.
  await uiLanguageReady

  // Onboarding vs Home vs the storage-error screen. Never rejects — see
  // `resolveInitialRoute`, whose whole point is that the listening-history
  // probe can't take the rest of startup with it.
  const target = await resolveInitialRoute(useLectorium(), preferences, startup.ready)

  await router.isReady()
  if (router.currentRoute.value.path !== target) {
    // Keep the query (e.g. ?locale) — a bare path replace would drop it.
    await router.replace({ path: target, query: router.currentRoute.value.query })
  }

  // The boot locale's message chunk was requested when i18n's module first
  // evaluated, so by now it has been downloading alongside everything above.
  // Awaiting it here means the first paint is already in the right language
  // instead of flashing the English fallback. It cannot reject — a locale that
  // fails to load leaves the app in `en` and mounts anyway.
  await bootLocaleReady
  mountApp()
  runPostMountWork()
}
