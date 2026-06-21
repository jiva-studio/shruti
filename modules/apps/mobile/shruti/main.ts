import { createApp } from "vue"
import { createPinia } from "pinia"
import { Capacitor } from "@capacitor/core"
import { IonicVue } from "@ionic/vue"

/* Core CSS required for Ionic components to work properly */
import "@ionic/vue/css/core.css"

/* Basic CSS for apps built with Ionic */
import "@ionic/vue/css/normalize.css"
import "@ionic/vue/css/structure.css"
import "@ionic/vue/css/typography.css"

/* Optional CSS utils that can be commented out */
import "@ionic/vue/css/padding.css"
import "@ionic/vue/css/float-elements.css"
import "@ionic/vue/css/text-alignment.css"
import "@ionic/vue/css/text-transformation.css"
import "@ionic/vue/css/flex-utils.css"
import "@ionic/vue/css/display.css"

/* Ionic dark mode follows the system setting. */
import "@ionic/vue/css/palettes/dark.system.css"

/* Theme variables + utility classes */
import "./theme/variables.css"
import "./theme/heatmap-colors.css"
import "./theme/misc.css"

/* Composition root + infrastructure adapters */
import App from "./App.vue"
import router from "./router/index.js"
import { i18n } from "./i18n/index.js"
import { initShruti } from "./shruti.js"
import { DEFAULT_APP_CONFIG } from "./services/app.config.js"
import { getRegions, hydrateRegions } from "@shruti/services/regionsRegistry.js"
import { useSqlJsPersistence } from "@infra/persistence/sqljs/index.js"
import { useCapacitorSqlPersistence } from "@infra/persistence/capacitor/index.js"
import { useDatabaseToIndexedDbFetcher } from "@infra/persistence/fetchers/idb/index.js"
import { useDatabaseToFsFetcher } from "@infra/persistence/fetchers/fs/index.js"
import { useCapacitorRemoteFilesStorage } from "@infra/files/capacitor/index.js"
import { useCapacitorAudioPlayer } from "@infra/audio/capacitor/index.js"
import { useCapacitorPurchases } from "@infra/purchases/capacitor/index.js"
import { useCapacitorAuth } from "@infra/auth/capacitor/useCapacitorAuth.js"
import { useShruti } from "@shruti/shruti.js"
import { useMediaDownloaderAdapter } from "@infra/mediaDownloader/plugin/index.js"
import { useHttpServerProber } from "@infra/servers/index.js"
import { createHttpProactiveChatService } from "@infra/chat/http/httpProactiveChatService.js"
import { useCapacitorExcerptCache } from "@infra/excerptCache/capacitor/index.js"
import {
  useWebRemoteFilesStorage,
  useCapacitorPreferences,
  useCapacitorNotificationScheduler,
  useCapacitorShareService,
  useCapacitorHaptics,
  useWebHaptics,
  useCapacitorDatabaseTransfer,
  useWebDatabaseTransfer,
} from "@kit/infra"
import { createFailoverClient } from "@kit/servers"
import { usePurchasesStore } from "./stores/usePurchasesStore.js"
import { useAuthStore } from "./stores/useAuthStore.js"
import { useLibraryLandingStore } from "./stores/useLibraryLandingStore.js"
import { runStartupBootstrap } from "./services/startup.js"
import { readOnboardingCompleted, ONBOARDING_COMPLETED_KEY } from "./stores/useOnboardingStore.js"
import { installConsoleCapture } from "./services/logger/index.js"
import { initMonitoring } from "./services/monitoring/index.js"
import { reportError } from "./services/monitoring/reportError.js"
import { withNetworkErrorContext } from "./services/http/networkError.js"

// Capture console.* into the in-memory debug buffer (Settings → Debug →
// "View logs") before anything else runs, so the subscription / proactive
// diagnostics emitted during bootstrap are recorded too.
installConsoleCapture()

// Init the composition root BEFORE the router is installed. router.install()
// triggers an immediate navigation, which runs `beforeEach` synchronously —
// and the guard calls `useShruti()`. If init is deferred to
// `router.isReady().then(...)` the singleton is still null at that point and
// guard explodes with "Shruti not initialized".
const isNative = Capacitor.isNativePlatform()
const platform = Capacitor.getPlatform() as "ios" | "android" | "web"

const config = { ...DEFAULT_APP_CONFIG }
if (isNative) {
  // Native persistence rewrites the user DB path to the sqlite plugin's
  // conventional location (getFilesDir()/<dbName>), so strip the
  // web-specific directory prefix here.
  config.database = { ...config.database, userLocalPath: "user.db" }
}

const preferences = useCapacitorPreferences()

// Two failover-aware HTTP clients — one for the auth service, one for
// chat. Both walk the runtime region list (regionsRegistry) in
// preferred-first order on transient failures; if the preferred has been
// unreachable for >5 min and a fallback succeeds, the active server is
// promoted (which persists preferredServerId via the watcher in
// initShruti). `getServers` is read per request, so a region list
// refreshed from the remote config is picked up without rebuilding.
const authHttp = createFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.authBaseUrl,
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})
const chatHttp = createFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.chatBaseUrl,
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})

initShruti({
  appConfig: config,
  persistence: isNative ? useCapacitorSqlPersistence() : useSqlJsPersistence(),
  databaseFetcher: isNative ? useDatabaseToFsFetcher() : useDatabaseToIndexedDbFetcher(),
  filesStorage: isNative
    ? useCapacitorRemoteFilesStorage({ cacheDir: "shruti" })
    : useWebRemoteFilesStorage({ cacheName: "shruti" }),
  preferences,
  // Capacitor plugin selects native vs its own web fallback automatically.
  audioPlayer: useCapacitorAudioPlayer(),
  notifications: useCapacitorNotificationScheduler(),
  shareService: useCapacitorShareService(),
  haptics: isNative ? useCapacitorHaptics() : useWebHaptics(),
  // Single Capacitor plugin (`MediaDownloader`) selects native or web at
  // runtime. On Android downloads continue under WorkManager when the app
  // is backgrounded/killed; on iOS via URLSession.background. Web stays a
  // foreground-only Cache API implementation, the same as before.
  mediaDownloader: useMediaDownloaderAdapter({ cacheDir: "shruti" }),
  // RevenueCat-backed IAP. Keys are baked in at build time via Vite
  // `define` (REVENUECAT_*_KEY env vars). Empty key → `available: false`
  // → the SDK is never touched and the Subscription UI hides itself.
  purchases: useCapacitorPurchases({
    iosApiKey: __REVENUECAT_IOS_KEY__,
    androidApiKey: __REVENUECAT_ANDROID_KEY__,
  }),
  // Auth service — anonymous-by-device bootstrap on first launch; Google /
  // Apple sign-in upgrades the same user when invoked from Settings.
  // `request` routes through the failover client so an unreachable
  // preferred backend transparently falls through to others.
  auth: useCapacitorAuth({
    request: withNetworkErrorContext((path, init) => authHttp.request(path, init)),
    googleWebClientId: __GOOGLE_WEB_CLIENT_ID__,
    googleIOSClientId: __GOOGLE_IOS_CLIENT_ID__,
  }),
  // Wraps Capacitor.Filesystem + HEAD probe — used by the Notes share
  // workflow to look up / download per-note excerpt files. Single
  // adapter; the operations are all native, the web build never hits
  // this path (no share workflow exists there yet).
  excerptCache: useCapacitorExcerptCache(),
  // `databaseTransfer` needs a `() => databases.user` getter; the factory is
  // invoked inside `initShruti` where that closure is available.
  databaseTransferFactory: (getUserDb) =>
    isNative
      ? useCapacitorDatabaseTransfer({
          getUserDb,
          exportFileName: () => `shruti.${Date.now()}.db`,
          shareTitle: "Shruti Database",
          // Hard reload: bootstrap re-opens the user DB and `runUserMigrations`
          // brings any older imported schema forward to current.
          onImported: () => {
            window.location.href = "/"
          },
        })
      : useWebDatabaseTransfer({
          userDbPath: config.database.userLocalPath,
          getUserDb,
          exportFileName: () => `shruti.${Date.now()}.db`,
          onImported: () => {
            window.location.href = "/"
          },
        }),
  platform,
  // Bootstrap seed only — the Welcome probe immediately overrides this via
  // setActiveServerById(probedId). After hydrateRegions() this is already
  // the last-persisted region, not necessarily the bundled default.
  initialServer: getRegions()[0]!,
  serverProber: useHttpServerProber(() => getRegions()),
  proactiveChat: createHttpProactiveChatService({
    getAccessToken: () => useShruti().auth.getAccessToken(),
    request: withNetworkErrorContext((path, init) => chatHttp.request(path, init)),
  }),
  chatHttpRequest: withNetworkErrorContext((path, init) => chatHttp.request(path, init)),
})

const app = createApp(App).use(createPinia()).use(IonicVue).use(i18n).use(router)

// Wire Sentry (native crash + WebView JS error reporting) before mount so the
// Vue error handler attaches to the live app. No-op when the DSN is empty or
// during a local web dev session.
initMonitoring(app)

// Dev-only debug bridge for the screenshots pipeline (modules/tools/screenshots).
// Production builds tree-shake this branch entirely — `VITE_DEBUG_API` is unset.
if (import.meta.env.VITE_DEBUG_API === "true") {
  void import("./services/debug/index.js").then(({ installDebugApi }) => {
    installDebugApi()
  })
}

// Headless startup, all before the first paint — there is NO loading screen.
// 1) Hydrate the region list from the last-persisted (downloaded) config so the
//    first CDN probe targets the latest regions, not the bundled seed.
// 2) Open the databases (the bundled DB makes this instant + offline on first
//    launch; cached on later launches). Failure is logged, not fatal.
// 3) Choose the initial route: first launch → onboarding, otherwise Home.
// The OS-native splash covers this brief, invisible work.
async function start(): Promise<void> {
  await hydrateRegions(preferences).catch((e) => {
    console.warn("[shruti] region hydration failed; using bundled defaults", e)
  })

  const startup = await runStartupBootstrap()
  if (!startup.ready) {
    reportError("startup", new Error(startup.error ?? "content database failed to open"))
  }

  // Skip first-launch onboarding for established users: the explicit
  // `onboarding.completed` flag (set at the end of the flow), OR any prior
  // listening session — the reliable signal for someone upgrading from a
  // pre-onboarding build, where the flag was never written. Stamp the flag
  // once inferred so later launches skip the DB probe.
  const completedFlag = await readOnboardingCompleted(preferences).catch(() => false)
  let hasHistory = false
  if (!completedFlag && startup.ready) {
    hasHistory = await useShruti()
      .repositories()
      .listeningSessions.hasAny()
      .catch(() => false)
    if (hasHistory) await preferences.set(ONBOARDING_COMPLETED_KEY, "true").catch(() => undefined)
  }
  const onboarded = completedFlag || hasHistory
  const target = onboarded ? "/tabs/home" : "/onboarding"

  await router.isReady()
  if (router.currentRoute.value.path !== target) {
    // Preserve the query (notably `?locale=…`, used by the screenshots pipeline
    // and e2e to pin the UI language) — a bare path replace would strip it
    // before `detectLocale()` reads it, falling back to the device language.
    await router.replace({ path: target, query: router.currentRoute.value.query })
  }
  app.mount("#app")

  // Fire-and-forget post-mount work. Failures must not block startup.
  void usePurchasesStore()
    .init()
    .catch((e) => reportError("purchases", e))
  void useAuthStore()
    .restore()
    .catch((e) => reportError("auth", e))
  void useLibraryLandingStore()
    .ensureLoaded()
    .catch((e) => console.warn("library landing preload failed", e))
}

void start()
