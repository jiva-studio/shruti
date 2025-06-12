import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

import { IonicVue } from '@ionic/vue'

/* Core CSS required for Ionic components to work properly */
import '@ionic/vue/css/core.css'

/* Basic CSS for apps built with Ionic */
import '@ionic/vue/css/normalize.css'
import '@ionic/vue/css/structure.css'
import '@ionic/vue/css/typography.css'

/* Optional CSS utils that can be commented out */
import '@ionic/vue/css/padding.css'
import '@ionic/vue/css/float-elements.css'
import '@ionic/vue/css/text-alignment.css'
import '@ionic/vue/css/text-transformation.css'
import '@ionic/vue/css/flex-utils.css'
import '@ionic/vue/css/display.css'

/**
 * Ionic Dark Mode
 * -----------------------------------------------------
 * For more info, please see:
 * https://ionicframework.com/docs/theming/dark-mode
 */

/* @import '@ionic/vue/css/palettes/dark.always.css'; */
/* @import '@ionic/vue/css/palettes/dark.class.css'; */
/* import '@ionic/vue/css/palettes/dark.system.css' */

/* Theme variables */
import './features/app.ui.kit/styles/variables.css'

import { createI18n } from 'vue-i18n'
import { useArchiveCompletedPlaylistItemsFeature } from './features/playlist/composables/useArchiveCompletedPlaylistItemsFeature'

/** 
 * Configure PouchDB to use SQLite adapter for Cordova
 */
import PouchDB from 'pouchdb'
import PouchDBAdapterSqlLite from 'pouchdb-adapter-cordova-sqlite'
PouchDB.plugin(PouchDBAdapterSqlLite)

import { useInAppPurchasesFeatures } from './features/app.purchases/composables/useInAppPurchasesFeatures'
import { Device } from '@capacitor/device'
import { initTrackStateFeature } from './init/initTrackStateFeature'
import { initTrackSearchFeature } from './init/initTrackSearchFeature'
import { useTracksCountFeature } from './features/tracks.count'
import { useTracksDownloadFeature } from './features/tracks.download'
import { useTrackStateStore } from './features/tracks.state'
import { locale } from './features/app.localization'
import { useCleanupMediaItemsFeature, useMarkCompletedPlaylistItem, usePlaylistFeature, useSyncPlaylistStoreTask } from './features/playlist'
import { useBucketService } from './features/app.services.bucket'
import { useMediaService } from './features/app.services.media'
import { useConfig, useConfigPersistenceTask } from './features/app.config'
import { useDAL, useDatabase } from './features/app.database'
import { useSentryFeature } from './features/app.infra.sentry'
import { useNavigationBarAppearanceTask, useSafeAreaTask } from './features/app.appearance'
import { useCleanupFilesFeature } from './features/app.storage'
import { usePlayerControls, useSetPlayerControlsInfoFeature, useSyncAudioPlayerPluginStateFeature } from './features/player'
import { useSyncTranscriptTask, useTranscriptStore } from './features/transcript'
import { useNotesLoader, useNotesSearchIndex, useNotesSearchTask, useNotesStore } from './features/notes'
import { useRestoreSubscriptionPlan } from './features/app.purchases'

const i18n = createI18n({
  locale: 'ru',
  fallbackLocale: 'en',
  messages: locale
})
const pinia = createPinia()
const app = createApp(App)
  .use(IonicVue)
  .use(router)
  .use(i18n)
  .use(pinia)

useSentryFeature(app)


router.isReady().then(async () => {
  const start = new Date().getTime()

  // Core //

  await useDatabase().init({
    remoteDatabaseUrl: useConfig().databaseUrl.value 
  })

  // App //

  await useConfigPersistenceTask().start()

  // app.appearance //
  await useNavigationBarAppearanceTask({
    isTranscriptDialogOpen: useTranscriptStore().isOpen
  }).start()
  await useSafeAreaTask().start()
  
  useMarkCompletedPlaylistItem()
  useArchiveCompletedPlaylistItemsFeature()
  useCleanupMediaItemsFeature()
  useCleanupFilesFeature()
  
  useSyncTranscriptTask({ 
    trackId: usePlayerControls().trackId,
    languagesService: useDAL().languages,
    tracksService: useDAL().tracks,
    notesService: useDAL().notes,
  })

  // Features //

  await initTrackStateFeature()
  initTrackSearchFeature()

  const dal = useDAL()
  await useTracksCountFeature().init({
    tracksService: dal.tracks
  })
  useTracksDownloadFeature().init({
    tracksService: useDAL().tracks,
    bucketName: useConfig().bucketName.value,
    bucketService: useBucketService(),
    mediaService: useMediaService(),
    onTrackFailed: (trackId) => {
      useTrackStateStore().setState(trackId, { isFailed: true })
    }
  })
  usePlaylistFeature().init({
    playlistService: dal.playlistItems,
  })
  await useNotesLoader({
    notesService: useDAL().notes,
    tracksService: useDAL().tracks,
    notesStore: useNotesStore()
  }).load()
  await useNotesSearchIndex().init({
    notesService: useDAL().notes
  })
  useNotesSearchTask({
    notesStore: useNotesStore()
  })

  // Player //

  useSyncAudioPlayerPluginStateFeature()
  useSetPlayerControlsInfoFeature()

  // Rest //

  await useInAppPurchasesFeatures().init()
  await useRestoreSubscriptionPlan().init()

  const config = useConfig()
  if (config.appLanguage.value === '??') {
    const languageCode = await Device.getLanguageCode()
    if (['en', 'ru'].includes(languageCode.value)) {
      config.appLanguage.value = languageCode.value
    } else {
      config.appLanguage.value = 'ru'
    }
  }
  i18n.global.locale = config.appLanguage.value as 'en' | 'ru'

  

  // Should be after database.init()
  await useSyncPlaylistStoreTask({
    playlistItemService: dal.playlistItems,
    language: config.appLanguage
  }).start()

  const elapsed = new Date().getTime() - start
  console.log(`Initialization time: ${elapsed}ms`)

  app.mount('#app')
})