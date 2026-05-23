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
import { initLectorium } from "./lectorium.js"
import { DEFAULT_APP_CONFIG } from "./services/app.config.js"
import { SERVERS } from "@lib/domain/servers.js"
import { useSqlJsPersistence } from "@infra/persistence/sqljs/index.js"
import { useCapacitorSqlPersistence } from "@infra/persistence/capacitor/index.js"
import { useDatabaseToIndexedDbFetcher } from "@infra/persistence/fetchers/idb/index.js"
import { useDatabaseToFsFetcher } from "@infra/persistence/fetchers/fs/index.js"
import { useWebRemoteFilesStorage } from "@infra/files/web/index.js"
import { useCapacitorRemoteFilesStorage } from "@infra/files/capacitor/index.js"
import { useCapacitorPreferences } from "@infra/preferences/capacitor/index.js"
import { useCapacitorAudioPlayer } from "@infra/audio/capacitor/index.js"
import { useCapacitorNotificationScheduler } from "@infra/notifications/capacitor/index.js"
import { useCapacitorShareService } from "@infra/share/capacitor/index.js"
import { useCapacitorHaptics } from "@infra/haptics/capacitor/index.js"
import { useCapacitorPurchases } from "@infra/purchases/capacitor/index.js"
import { useCapacitorAuth } from "@infra/auth/capacitor/useCapacitorAuth.js"
import { setAccessTokenProvider } from "@lectorium/services/chatClient.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useWebHaptics } from "@infra/haptics/web/index.js"
import { useMediaDownloaderAdapter } from "@infra/mediaDownloader/plugin/index.js"
import { useHttpServerProber } from "@infra/servers/index.js"
import { useHttpProactiveChatService } from "@lectorium/services/chat/httpProactiveChatService.js"
import { useCapacitorDatabaseTransfer } from "@infra/databaseTransfer/capacitor/index.js"
import { useWebDatabaseTransfer } from "@infra/databaseTransfer/web/index.js"
import { useCapacitorExcerptCache } from "@infra/excerptCache/capacitor/index.js"
import { usePurchasesStore } from "./stores/usePurchasesStore.js"
import { useAuthStore } from "./stores/useAuthStore.js"

// Init the composition root BEFORE the router is installed. router.install()
// triggers an immediate navigation, which runs `beforeEach` synchronously —
// and the guard calls `useLectorium()`. If init is deferred to
// `router.isReady().then(...)` the singleton is still null at that point and
// guard explodes with "Lectorium not initialized".
const isNative = Capacitor.isNativePlatform()
const platform = Capacitor.getPlatform() as "ios" | "android" | "web"

const config = { ...DEFAULT_APP_CONFIG }
if (isNative) {
  // Native persistence rewrites the user DB path to the sqlite plugin's
  // conventional location (getFilesDir()/<dbName>), so strip the
  // web-specific directory prefix here.
  config.database = { ...config.database, userLocalPath: "user.db" }
}

initLectorium({
  appConfig: config,
  persistence: isNative ? useCapacitorSqlPersistence() : useSqlJsPersistence(),
  databaseFetcher: isNative ? useDatabaseToFsFetcher() : useDatabaseToIndexedDbFetcher(),
  filesStorage: isNative
    ? useCapacitorRemoteFilesStorage({ cacheDir: "lectorium" })
    : useWebRemoteFilesStorage({ cacheName: "lectorium" }),
  preferences: useCapacitorPreferences(),
  // Capacitor plugin selects native vs its own web fallback automatically.
  audioPlayer: useCapacitorAudioPlayer(),
  notifications: useCapacitorNotificationScheduler(),
  shareService: useCapacitorShareService(),
  haptics: isNative ? useCapacitorHaptics() : useWebHaptics(),
  // Single Capacitor plugin (`MediaDownloader`) selects native or web at
  // runtime. On Android downloads continue under WorkManager when the app
  // is backgrounded/killed; on iOS via URLSession.background. Web stays a
  // foreground-only Cache API implementation, the same as before.
  mediaDownloader: useMediaDownloaderAdapter({ cacheDir: "lectorium" }),
  // RevenueCat-backed IAP. Keys are baked in at build time via Vite
  // `define` (REVENUECAT_*_KEY env vars). Empty key → `available: false`
  // → the SDK is never touched and the Subscription UI hides itself.
  purchases: useCapacitorPurchases({
    iosApiKey: __REVENUECAT_IOS_KEY__,
    androidApiKey: __REVENUECAT_ANDROID_KEY__,
  }),
  // Auth service — anonymous-by-device bootstrap on first launch; Google /
  // Apple sign-in upgrades the same user when invoked from Settings.
  auth: useCapacitorAuth({
    baseUrl: __AUTH_API_BASE_URL__,
    googleWebClientId: __GOOGLE_WEB_CLIENT_ID__,
    googleIOSClientId: __GOOGLE_IOS_CLIENT_ID__,
  }),
  // Wraps Capacitor.Filesystem + HEAD probe — used by the Notes share
  // workflow to look up / download per-note excerpt files. Single
  // adapter; the operations are all native, the web build never hits
  // this path (no share workflow exists there yet).
  excerptCache: useCapacitorExcerptCache(),
  // `databaseTransfer` needs a `() => databases.user` getter; the factory is
  // invoked inside `initLectorium` where that closure is available.
  databaseTransferFactory: (getUserDb) =>
    isNative
      ? useCapacitorDatabaseTransfer(getUserDb)
      : useWebDatabaseTransfer(config.database.userLocalPath, getUserDb),
  platform,
  initialServer: SERVERS[0],
  serverProber: useHttpServerProber(),
  proactiveChat: useHttpProactiveChatService(),
})

const app = createApp(App).use(createPinia()).use(IonicVue).use(i18n).use(router)

// Dev-only debug bridge for the screenshots pipeline (modules/tools/screenshots).
// Production builds tree-shake this branch entirely — `VITE_DEBUG_API` is unset.
if (import.meta.env.VITE_DEBUG_API === "true") {
  void import("./services/debug/index.js").then(({ installDebugApi }) => {
    installDebugApi()
  })
}

router.isReady().then(() => {
  app.mount("#app")
  // Fire-and-forget: RevenueCat SDK configure + initial customer fetch
  // + live-update subscription. Failures must not block app startup —
  // the purchase UI just stays hidden if init fails.
  void usePurchasesStore()
    .init()
    .catch((e) => {
      console.warn("purchases.init failed", e)
    })
  // Wire chatClient's module-level access-token provider to the auth
  // port. Done before useAuthStore().restore() so even a chat call that
  // races with restore() (cold-start auto-resume scenarios) finds the
  // provider — the provider itself awaits initialize() internally.
  setAccessTokenProvider(() => useLectorium().auth.getAccessToken())

  // Bootstrap anonymous-by-device session. Resolves the persistent
  // userId asynchronously; the rest of the app reads it via useAuthStore.
  void useAuthStore()
    .restore()
    .catch((e) => {
      console.warn("auth.restore failed", e)
    })
})
