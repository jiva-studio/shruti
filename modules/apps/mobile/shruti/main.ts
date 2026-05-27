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
import { SERVERS } from "@lib/domain/servers.js"
import { useSqlJsPersistence } from "@infra/persistence/sqljs/index.js"
import { useCapacitorSqlPersistence } from "@infra/persistence/capacitor/index.js"
import { useDatabaseToIndexedDbFetcher } from "@infra/persistence/fetchers/idb/index.js"
import { useDatabaseToFsFetcher } from "@infra/persistence/fetchers/fs/index.js"
import { useWebRemoteFilesStorage } from "@infra/files/web/index.js"
import { useCapacitorRemoteFilesStorage } from "@infra/files/capacitor/index.js"
import { useCapacitorPreferences } from "@infra/preferences/capacitor/index.js"
import { makeScheduledRevoke } from "./services/scheduledRevoke.js"
import { useCapacitorAudioPlayer } from "@infra/audio/capacitor/index.js"
import { useCapacitorNotificationScheduler } from "@infra/notifications/capacitor/index.js"
import { useCapacitorShareService } from "@infra/share/capacitor/index.js"
import { useCapacitorHaptics } from "@infra/haptics/capacitor/index.js"
import { useCapacitorPurchases } from "@infra/purchases/capacitor/index.js"
import { useCapacitorAuth } from "@infra/auth/capacitor/useCapacitorAuth.js"
import { useShruti } from "@shruti/shruti.js"
import { useWebHaptics } from "@infra/haptics/web/index.js"
import { useMediaDownloaderAdapter } from "@infra/mediaDownloader/plugin/index.js"
import { useHttpServerProber } from "@infra/servers/index.js"
import { useHttpProactiveChatService } from "@infra/chat/http/httpProactiveChatService.js"
import { useCapacitorDatabaseTransfer } from "@infra/databaseTransfer/capacitor/index.js"
import { useWebDatabaseTransfer } from "@infra/databaseTransfer/web/index.js"
import { useCapacitorExcerptCache } from "@infra/excerptCache/capacitor/index.js"
import { usePurchasesStore } from "./stores/usePurchasesStore.js"
import { useAuthStore } from "./stores/useAuthStore.js"

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

// Shared Preferences adapter — same instance used by the auth port and
// the scheduled-revoke queue, so an in-memory web fallback (if it ever
// lands) would see consistent state across both consumers.
const preferences = useCapacitorPreferences()

// Resolve an auth base URL for a region OTHER than the active one.
// Used by migrate-in to reach the destination region and by the
// scheduled-revoke queue to reach the prior source on drain.
function resolveAuthBaseUrl(regionId: string): string {
  const server = SERVERS.find((s) => s.id === regionId)
  if (!server) throw new Error(`Unknown region: ${regionId}`)
  return server.authBaseUrl
}

const scheduledRevoke = makeScheduledRevoke({ prefs: preferences, resolveAuthBaseUrl })

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
  // `baseUrl` is a lazy getter: resolved at each fetch call against
  // `shruti.activeServer.value.authBaseUrl`, so a region flip via
  // Settings routes subsequent auth traffic to the new backend.
  auth: useCapacitorAuth({
    baseUrl: () => useShruti().activeServer.value.authBaseUrl,
    resolveAuthBaseUrl,
    currentRegionId: () => useShruti().activeServer.value.id,
    // Post-migration: flip activeServer so every subsequent fetch
    // (auth/chat/share-*) targets the destination. The activeServer
    // watcher inside initShruti persists the id under
    // preferredServerId so a cold start lands on the new region. Then
    // enqueue the source-side revoke and try to drain it once while we
    // likely still have network. The watcher on `useAuthStore.userId`
    // in `usePurchasesStore.init()` already re-links RC when the new
    // session lands — no extra logIn() call is needed here.
    onMigrationCompleted: (newRegionId, sourceRegionId, sourceBearer) => {
      useShruti().setActiveServerById(newRegionId)
      void scheduledRevoke.enqueue(sourceRegionId, sourceBearer).then(() => {
        void scheduledRevoke.drain()
      })
    },
    // After every /auth/me, if the server's authoritative home region
    // disagrees with the local `activeServer.id`, sync local to server.
    // Server is the source of truth — local was drifting (e.g. user
    // flipped the picker manually after a migration, or older builds
    // never reconciled). Silently ignore unknown region ids so a server
    // returning a region this build doesn't ship doesn't crash.
    onHomeRegionMismatch: (serverRegion, localRegion) => {
      const shruti = useShruti()
      const known = shruti.appConfig.servers.some((s) => s.id === serverRegion)
      if (!known) {
        console.warn("[auth] home region drift (unknown to this build, ignoring)", {
          server: serverRegion,
          local: localRegion,
        })
        return
      }
      console.warn("[auth] home region drift; syncing local to server", {
        server: serverRegion,
        local: localRegion,
      })
      shruti.setActiveServerById(serverRegion)
    },
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
      ? useCapacitorDatabaseTransfer(getUserDb)
      : useWebDatabaseTransfer(config.database.userLocalPath, getUserDb),
  platform,
  initialServer: SERVERS[0],
  serverProber: useHttpServerProber(),
  // Lazy auth-token resolver: useShruti() returns the composition
  // root, which is only fully wired after initShruti() — but the
  // closure runs at request time (when the scheduler invokes a
  // proactive turn), well after init has completed.
  proactiveChat: useHttpProactiveChatService({
    getAccessToken: () => useShruti().auth.getAccessToken(),
    baseUrl: () => useShruti().activeServer.value.chatBaseUrl,
  }),
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
  // Bootstrap anonymous-by-device session. Resolves the persistent
  // userId asynchronously; the rest of the app reads it via useAuthStore.
  void useAuthStore()
    .restore()
    .catch((e) => {
      console.warn("auth.restore failed", e)
    })
  // Drain any pending `/auth/migrate-revoke` calls left over from a
  // prior session where the source region was unreachable at migration
  // time. Best-effort: failed retries get re-queued for the next start.
  void scheduledRevoke.drain().catch((e) => {
    console.warn("scheduledRevoke.drain failed", e)
  })
})
