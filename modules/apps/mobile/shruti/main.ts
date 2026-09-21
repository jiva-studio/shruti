import "./polyfills.js"
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
import { getRegions } from "@shruti/services/regionsRegistry.js"
import { initShruti } from "./shruti.js"
import { DEFAULT_APP_CONFIG } from "./services/app.config.js"
import { DATABASES_DIR } from "./services/contentDatabase.js"
import { EXCERPTS_DIR, MEDIA_ROOT_DIR } from "./services/storageLayout.js"
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
import { useCapacitorExcerptCache } from "@infra/excerptCache/capacitor/index.js"
import { useCapacitorPreferenceKeys } from "@infra/preferences/index.js"
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
import { runPostMountWork } from "./services/postMount.js"
import { installConsoleCapture } from "./services/logger/index.js"
import { initMonitoring } from "./services/monitoring/index.js"
import { reportError } from "./services/monitoring/reportError.js"
import { createHttpProactiveChatService } from "@infra/chat/http/httpProactiveChatService.js"
import { createHttpSyncClient } from "@infra/sync/http/syncClient.js"
import { createHttpIngestClient } from "@infra/ingest/http/ingestClient.js"
import { createHttpDiscoveryClient } from "@infra/discovery/http/discoveryClient.js"
import { createServiceRequests } from "./services/serviceRequests.js"
import { runBootSequence } from "./services/bootSequence.js"

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

const { authRequest, chatRequest, profileRequest, ingestRequest, discoveryRequest, getDeviceId } =
  createServiceRequests()

const syncClient = createHttpSyncClient({
  // No bootstrap fallback: everything this client sends belongs to the account
  // the cycle read it for. Minting a fresh anonymous session and POSTing into
  // it would mark the rows sent and lose the batch for good.
  getAccessToken: () => useShruti().auth.getAccessToken({ allowBootstrap: false }),
  request: profileRequest,
})
const ingestClient = createHttpIngestClient({
  getAccessToken: () => useShruti().auth.getAccessToken(),
  request: ingestRequest,
})
const discoveryClient = createHttpDiscoveryClient({
  getAccessToken: () => useShruti().auth.getAccessToken(),
  request: discoveryRequest,
})

initShruti({
  appConfig: config,
  persistence: isNative ? useCapacitorSqlPersistence() : useSqlJsPersistence(),
  databaseFetcher: isNative ? useDatabaseToFsFetcher() : useDatabaseToIndexedDbFetcher(),
  filesStorage: isNative
    ? // `databases/` holds the content catalog and the user DB, not cache —
      // see `resetContentDatabase` for the path that is allowed to drop it.
      useCapacitorRemoteFilesStorage({ cacheDir: MEDIA_ROOT_DIR, keep: [DATABASES_DIR] })
    : useWebRemoteFilesStorage({ cacheName: MEDIA_ROOT_DIR }),
  preferences,
  preferenceKeys: useCapacitorPreferenceKeys(),
  // Capacitor plugin selects native vs its own web fallback automatically.
  audioPlayer: useCapacitorAudioPlayer(),
  notifications: useCapacitorNotificationScheduler(),
  shareService: useCapacitorShareService(),
  haptics: isNative ? useCapacitorHaptics() : useWebHaptics(),
  // One plugin, native or web at runtime: Android continues under WorkManager
  // when the app is backgrounded, iOS via URLSession.background, web is
  // foreground-only.
  mediaDownloader: useMediaDownloaderAdapter({ cacheDir: MEDIA_ROOT_DIR }),
  // RevenueCat-backed IAP. Keys are baked in at build time via Vite
  // `define` (REVENUECAT_*_KEY env vars). Empty key → `available: false`
  // → the SDK is never touched and the Subscription UI hides itself.
  purchases: useCapacitorPurchases({
    iosApiKey: __REVENUECAT_IOS_KEY__,
    androidApiKey: __REVENUECAT_ANDROID_KEY__,
  }),
  // Anonymous-by-device bootstrap on first launch; Google / Apple sign-in
  // upgrades the same user. `request` falls through to another region so a
  // device on a dead edge still gets an identity.
  auth: useCapacitorAuth({
    request: authRequest,
    googleWebClientId: __GOOGLE_WEB_CLIENT_ID__,
    googleIOSClientId: __GOOGLE_IOS_CLIENT_ID__,
    // Lets the email-OTP request tell the server which language to send the
    // code email in (falls back to English server-side for unmapped locales).
    getLocale: () => String(i18n.global.locale.value),
  }),
  // Per-note excerpt files for the Notes share workflow. Written INSIDE the
  // files-storage root so "Clear cache" and the account wipe reach them.
  excerptCache: useCapacitorExcerptCache({ cacheDir: EXCERPTS_DIR }),
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
  // Orchestrator ingest control plane (POST /orchestrator/run, GET
  // /orchestrator/run/{id}) — the direct add/retry + live-status transport
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

// Nothing in `start()` is allowed to cost the user the app. Whatever blew up,
// mount anyway: a degraded Home beats the blank WebView a bare `void start()`
// left behind when an await rejected (issue #1605).
//
// Loud on purpose. This handler used to mount and stop there, so a run that
// never got a session — no anonymous bootstrap, every authenticated call a 401 —
// looked exactly like a healthy one from the inside (#1738). `console.error`
// reaches the in-app debug buffer AND Sentry's captureConsole bridge; the
// post-mount work runs anyway, because an identity is not optional.
void runBootSequence(preferences, mountApp).catch((e) => {
  console.error("[shruti] startup did not finish; mounting in a degraded state", e)
  reportError("startup", e)
  mountApp()
  runPostMountWork()
})
