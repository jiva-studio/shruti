import "./polyfills.js"
import { createApp } from "vue"
import { createPinia } from "pinia"
import { Capacitor } from "@capacitor/core"
import { Device } from "@capacitor/device"
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
import { bootLocaleReady, i18n } from "./i18n/index.js"
import { applyStoredAppLanguage } from "./composables/useAppLanguage.js"
import { initShruti } from "./shruti.js"
import { DEFAULT_APP_CONFIG } from "./services/app.config.js"
import { DATABASES_DIR } from "./services/contentDatabase.js"
import { findRegion, getRegions, hydrateRegions } from "@shruti/services/regionsRegistry.js"
import { readPreferredServerId } from "@shruti/services/preferredServer.js"
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
import { createHttpSyncClient } from "@infra/sync/http/syncClient.js"
import { createHttpIngestClient } from "@infra/ingest/http/ingestClient.js"
import { createHttpDiscoveryClient } from "@infra/discovery/http/discoveryClient.js"
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
import {
  createRegionFailoverClient,
  isReplayableAuthPath,
  withCrossServerReplay,
} from "./services/regionFailover.js"
import { usePurchasesStore } from "./stores/usePurchasesStore.js"
import { useAuthStore } from "./stores/useAuthStore.js"
import { useLibraryLandingStore } from "./stores/useLibraryLandingStore.js"
import { runStartupBootstrap } from "./services/startup.js"
import { readOnboardingCompleted, ONBOARDING_COMPLETED_KEY } from "./stores/useOnboardingStore.js"
import { installConsoleCapture } from "./services/logger/index.js"
import { initMonitoring } from "./services/monitoring/index.js"
import { reportError } from "./services/monitoring/reportError.js"
import { withNetworkErrorContext } from "./services/http/networkError.js"
import { createUnauthorizedRetry } from "./services/http/unauthorizedRetry.js"

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
const authHttp = createRegionFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.authBaseUrl,
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})
const chatHttp = createRegionFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.chatBaseUrl,
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})

// One 401 interceptor for every authenticated service client. The state that
// makes N simultaneous 401s collapse into a single /auth/refresh lives on this
// factory, so it must be created once and shared — wrapping each client with
// its own `createUnauthorizedRetry` would refresh once per client.
//
// `authHttp` is deliberately NOT wrapped: a 401 from /auth/refresh IS the
// answer (the refresh token is dead), and retrying it would recurse.
const withUnauthorizedRetry = createUnauthorizedRetry({
  refreshAccessToken: () => useShruti().auth.refreshAccessToken(),
})

// Shared by the SSE turn stream and the proactive service — one decorated fn
// rather than two, so both go through the same interceptor instance. A turn
// carries an `Idempotency-Key` and lands in one shared turn store whichever
// edge accepts it, so it may be re-issued elsewhere; `/chat/feedback` and the
// per-turn calls keep the method default.
const chatRequest = withUnauthorizedRetry(
  withNetworkErrorContext(
    withCrossServerReplay(
      (path, init) => chatHttp.request(path, init),
      (path) => path === "/chat"
    )
  )
)

// Stable device id (Capacitor Device.getId()), memoized. The single source of
// this device's identity for the HLC tiebreak + `sync_state` key (via the
// repository bundle) and the cursor-ack `device_id`. Matches how the auth
// adapter obtains it, so they agree.
const getDeviceId = (() => {
  let cached: Promise<string> | null = null
  return () => (cached ??= Device.getId().then((r) => r.identifier))
})()

// Profile-sync failover client. Routes ONLY on `profileBaseUrl` — no fallback
// to chat. A region whose published config predates the `profile` service has
// no `profileBaseUrl`; the sync engine is then disabled at runtime (the
// `useSyncEngine` composable gates on it) and this client is never invoked.
const profileHttp = createRegionFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.profileBaseUrl ?? "",
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})
const syncClient = createHttpSyncClient({
  getAccessToken: () => useShruti().auth.getAccessToken(),
  // pull / push / cursor are HLC + LWW against one profile DB — a repeat
  // converges — so they may be re-issued against another edge.
  request: withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        (path, init) => profileHttp.request(path, init),
        (path) => path.startsWith("/profile/sync/")
      )
    )
  ),
})

// Orchestrator ingest control-plane failover client.
const orchestratorHttp = createRegionFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.orchestratorBaseUrl ?? "",
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})
const ingestClient = createHttpIngestClient({
  getAccessToken: () => useShruti().auth.getAccessToken(),
  request: withUnauthorizedRetry(
    withNetworkErrorContext((path, init) => orchestratorHttp.request(path, init))
  ),
})

// Discovery search failover client. A published config.json predating the
// field omits it — fall back to chatBaseUrl, since /discovery/search sits
// behind the same Caddy as chat, the way shareTranscriptUrl does.
const discoveryHttp = createRegionFailoverClient({
  getServers: () => getRegions(),
  getPreferredId: () => useShruti().activeServer.value.id,
  pickBaseUrl: (s) => s.discoveryBaseUrl ?? s.chatBaseUrl ?? "",
  onPromoteFallback: (id) => useShruti().setActiveServerById(id),
})
const discoveryClient = createHttpDiscoveryClient({
  getAccessToken: () => useShruti().auth.getAccessToken(),
  // `/discovery/search` is a POST only because its filter does not fit in a
  // query string — it writes nothing, so it walks the candidate list like a
  // read. Distinct doors only: `createRegionFailoverClient` collapses the
  // regions that resolve to one discovery host, so a 503 no longer fans one
  // search out into three requests against it.
  request: withUnauthorizedRetry(
    withNetworkErrorContext(
      withCrossServerReplay(
        (path, init) => discoveryHttp.request(path, init),
        () => true
      )
    )
  ),
})

initShruti({
  appConfig: config,
  persistence: isNative ? useCapacitorSqlPersistence() : useSqlJsPersistence(),
  databaseFetcher: isNative ? useDatabaseToFsFetcher() : useDatabaseToIndexedDbFetcher(),
  filesStorage: isNative
    ? // `databases/` holds the content catalog and the user DB, not cache —
      // see `resetContentDatabase` for the path that is allowed to drop it.
      useCapacitorRemoteFilesStorage({ cacheDir: "shruti", keep: [DATABASES_DIR] })
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
  // preferred backend transparently falls through to others — including
  // the anonymous mint, without which a device on a dead edge boots with
  // no identity at all (see `isReplayableAuthPath` for the carve-outs).
  auth: useCapacitorAuth({
    request: withNetworkErrorContext(
      withCrossServerReplay((path, init) => authHttp.request(path, init), isReplayableAuthPath)
    ),
    googleWebClientId: __GOOGLE_WEB_CLIENT_ID__,
    googleIOSClientId: __GOOGLE_IOS_CLIENT_ID__,
    // Lets the email-OTP request tell the server which language to send the
    // code email in (falls back to English server-side for unmapped locales).
    getLocale: () => String(i18n.global.locale.value),
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
    request: chatRequest,
  }),
  chatHttpRequest: chatRequest,
  // Profile device↔server sync (Lane D). `getDeviceId` also enables the
  // sync-journal decorator + the engine repositories in the bundle; `syncClient`
  // is the transport the `useSyncEngine` composable drives when enabled.
  getDeviceId,
  syncClient,
  // Orchestrator ingest control plane (POST /orchestrator/ingest, GET
  // /orchestrator/ingest/{id}) — the direct add/retry + live-status transport
  // the library store drives; nil-URL regions fall back to the chat path.
  ingestClient,
  discoveryClient,
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

// A hashed chunk that 404s after a web deploy, or dies on a flaky radio, lands
// here before it lands in the importer's own `.catch`. Every dynamic import the
// app makes has a fallback, so acknowledge the event (preventDefault stops Vite
// re-throwing it at the window) and just record it.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault()
  reportError("preload", (event as Event & { payload?: unknown }).payload ?? event)
})

// Mounting is the one step that must happen exactly once, whatever else fails —
// the native splash dismisses onto whatever is (or isn't) in the WebView.
let mounted = false
function mountApp(): void {
  if (mounted) return
  mounted = true
  app.mount("#app")
}

// Headless startup, all before the first paint — there is NO loading screen.
// 1) Hydrate the region list from the last-persisted (downloaded) config so the
//    first CDN probe targets the latest regions, not the bundled seed.
// 2) Open the databases (the bundled DB makes this instant + offline on first
//    launch; cached on later launches). Failure is logged, not fatal.
// 3) Choose the initial route: first launch → onboarding, otherwise Home.
// The OS-native splash covers this brief, invisible work.
async function start(): Promise<void> {
  // i18n boots on the DEVICE locale, which is not necessarily the one the user
  // picked in Settings. Kick the stored choice's chunk off first thing so it
  // downloads alongside everything below, and await it before the mount — the
  // first paint is then in the chosen language rather than flashing the device
  // one and swapping the whole screen a moment later (issue #1606).
  const uiLanguageReady = applyStoredAppLanguage(preferences)

  await hydrateRegions(preferences).catch((e) => {
    console.warn("[shruti] region hydration failed; using bundled defaults", e)
  })

  // Seed the active region from the user's last explicit pick (Settings
  // server picker) BEFORE the bootstrap probe, so the probe tries it
  // first instead of always preferring the config's first region. A
  // stored id that no longer exists in the hydrated region list is
  // ignored — the probe falls back to the bundled default order.
  const preferredId = await readPreferredServerId(preferences)
  if (preferredId && findRegion(preferredId)) {
    useShruti().setActiveServerById(preferredId)
  }

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
    // Keep the query (e.g. ?locale) — a bare path replace would drop it.
    await router.replace({ path: target, query: router.currentRoute.value.query })
  }

  // The boot locale's message chunk was requested when i18n's module first
  // evaluated, so by now it has been downloading alongside everything above.
  // Awaiting it here means the first paint is already in the right language
  // instead of flashing the English fallback. Neither promise can reject —
  // a locale that fails to load leaves the app in `en` and mounts anyway.
  await Promise.all([bootLocaleReady, uiLanguageReady])
  mountApp()

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

// Nothing in `start()` is allowed to cost the user the app. Whatever blew up,
// mount anyway: a degraded Home beats the blank WebView a bare `void start()`
// left behind when an await rejected (issue #1605).
void start().catch((e) => {
  reportError("startup", e)
  mountApp()
})
