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
import { useCapacitorAudioPlayer } from "@infra/audio/capacitor/index.js"
import { useCapacitorNotificationScheduler } from "@infra/notifications/capacitor/index.js"
import { useCapacitorShareService } from "@infra/share/capacitor/index.js"
import { useCapacitorHaptics } from "@infra/haptics/capacitor/index.js"
import { useWebHaptics } from "@infra/haptics/web/index.js"
import { useMediaDownloaderAdapter } from "@infra/mediaDownloader/plugin/index.js"
import { useHttpServerProber } from "@infra/servers/index.js"

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

initShruti({
  appConfig: config,
  persistence: isNative ? useCapacitorSqlPersistence() : useSqlJsPersistence(),
  databaseFetcher: isNative ? useDatabaseToFsFetcher() : useDatabaseToIndexedDbFetcher(),
  filesStorage: isNative
    ? useCapacitorRemoteFilesStorage({ cacheDir: "shruti" })
    : useWebRemoteFilesStorage({ cacheName: "shruti" }),
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
  mediaDownloader: useMediaDownloaderAdapter({ cacheDir: "shruti" }),
  platform,
  initialServer: SERVERS[0],
  serverProber: useHttpServerProber(),
})

const app = createApp(App).use(createPinia()).use(IonicVue).use(i18n).use(router)

router.isReady().then(() => {
  app.mount("#app")
})
