import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LectoriumApp from './App.vue'
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
import '@blocks/app.ui.kit/styles/variables.css'

/** 
 * Configure PouchDB to use SQLite adapter for Cordova
 */
import PouchDB from 'pouchdb'
import PouchDBAdapterSqlLite from 'pouchdb-adapter-cordova-sqlite'
PouchDB.plugin(PouchDBAdapterSqlLite)

import { useTracksCountFeature } from '@blocks/app.tracks.count'

import { usePlaylist } from '@blocks/app.playlist'
import { useConfig, useConfigPersistenceTask } from '@blocks/app.config'
import { useDAL, useLocalDatabase, useRemoteDatabase } from '@blocks/app.database'
import { useSentryFeature } from '@blocks/app.infra.sentry'
import { useNavigationBar, useSafeAreaTask } from '@blocks/app.appearance'
import { useTranscriptLoader } from '@blocks/app.transcript'
import { useTrackSearchFiltersPersistenceTask } from '@blocks/app.tracks.search.results'
import { useAnalytics } from '@blocks/app.analytics'
import { setupAuthenticationFeature } from './features/setupAuthenticationFeature'
import { setupFilesFeature } from './features/setupFilesFeature'
import { setupNotesFeature } from './features/setupNotesFeature'
import { setupPlayerFeature } from './features/setupPlayerFeature'
import { setupPlaylistFeature } from './features/setupPlaylistFeature'
import { setupSubscriptionFeature } from './features/setupSubscriptionFeature'
import { setupSyncFeature } from './features/setupSyncFeature'
import { setupTracksDownloadFeature } from './features/setupTracksDownloadFeature'
import { setupTracksStateFeature } from './features/setupTracksStateFeature.ts'
import { setupTranscriptFeature } from './features/setupTranscriptFeature'
import { setupI18nFeature } from './features/seupI18nFeature'
import { setupTracksSearchFeature } from './features/setupTracksSearchFeature'
import { setupAnalyticsFeature } from './features/setupAnalyticsFeature'
import { setupAppearanceFeature } from './features/setupAppearanceFeature'
import { setupTutorialFeature } from './features/setupTutorialFeature'

import { useEventBus } from '@lectorium/mobile/core'
import { useSyncData } from '@blocks/app.sync.data'
import { useSubscription } from '@blocks/app.purchases'
import { useAuthTokenRefresher } from '@blocks/app.auth'
import { useUserInfo } from '@blocks/app.auth/composables/useUserInfo'
import { useIdGenerator } from '@blocks/app.core'
import { useBucketService } from '@blocks/app.services.bucket'
import { useSyncMedia } from '@blocks/app.sync.media'
import { useTrackMediaItems } from '@blocks/app.tracks.mediaItems'
import { useTrackMediaItemsDownloader } from '@blocks/app.tracks.mediaItems.downloader'
import { useTracksState } from '@blocks/app.tracks.state'
import { useNotes } from '@blocks/app.notes'
import { useLocalization } from '@blocks/app.localization'


const i18n = useLocalization()
const pinia = createPinia()
const app = createApp(LectoriumApp)
  .use(IonicVue)
  .use(router)
  .use(i18n)
  .use(pinia)

useSentryFeature(app)


router.isReady().then(async () => {
  const start = new Date().getTime()

  await useConfigPersistenceTask().start()

  await useLocalDatabase().init()
  useRemoteDatabase().init({
    url: useConfig().databaseUrl.value,
    authToken: useConfig().authToken.value,
    userId: useConfig().userEmail.value
  })

  const dal = useDAL()
  const config = useConfig()
  useSyncData().init({
    local: () => useLocalDatabase().get(),
    remote: () => useRemoteDatabase().get(),
  })
  useSyncMedia().init({
    mediaItemsRepository: dal.mediaItems, 
    playlistItemsRepository: dal.playlistItems,
  })
  useTracksState().init({
    mediaItemsRepository: dal.mediaItems,
    playlistItemsRepository: dal.playlistItems,
  })
  useAuthTokenRefresher().init({
    apiUrl: config.apiUrl.value,
  })
  // const userAvatarDownloader = useUserAvatarDownloader()
  useUserInfo().init({
    database: useLocalDatabase().get().userData,
  })
  useSubscription().init(config.userEmail.value)
  useTrackMediaItems().init({
    bucketName: config.bucketName.value,
    bucketService: useBucketService(),
    tracksRepository: dal.tracks,
    mediaItemsRepository: dal.mediaItems,
    uniqueIdGenerator: () => useIdGenerator().generateId(24)
  })
  useTrackMediaItemsDownloader().init({ 
    mediaItemsRepository: dal.mediaItems,
    maxConcurrentDownloads: 3
  })
  useNotes().init({
    idGenerator: () => useIdGenerator().generateId(24),
    notesRepository: dal.notes,
    tracksRepository: dal.tracks,
  })
  useTranscriptLoader().init({
    tracksRepository: dal.tracks,
    languagesRepository: dal.languages,
    notesRepository: dal.notes,
  })
  
  await Promise.all([
    dal.tags.getAll({ limit: 1000 }),
    dal.authors.getAll({ limit: 1000 }),
    dal.sources.getAll({ limit: 1000 }),
    dal.locations.getAll({ limit: 1000 }),
    dal.languages.getAll({ limit: 1000 }),
    dal.durations.getAll({ limit: 1000 }),
    dal.sortMethods.getAll({ limit: 1000 }),
  ])

  await useNavigationBar().init()
  await useSafeAreaTask().start()
  
  await useTracksCountFeature().init({
    tracksRepo: dal.tracks
  })
  usePlaylist().init({
    playlistItemsRepository: dal.playlistItems,
    tracksRepository: dal.tracks,
    idGenerator: () => useIdGenerator().generateId(24),
  })


  await useTrackSearchFiltersPersistenceTask().start()
  useAnalytics().init(config.userEmail.value)

  setupAnalyticsFeature()
  setupAppearanceFeature()
  setupAuthenticationFeature()
  setupFilesFeature()
  setupNotesFeature()
  setupPlayerFeature()
  setupPlaylistFeature()
  setupSubscriptionFeature()
  setupSyncFeature()
  setupTracksDownloadFeature()
  setupTracksSearchFeature()
  setupTracksStateFeature()
  setupTranscriptFeature()
  setupI18nFeature()
  setupTutorialFeature()


  /* -------------------------------------------------------------------------- */
  /*                             Fire Initial Events                            */
  /* -------------------------------------------------------------------------- */

  useEventBus().playlistLoadEnd.subscribe(async () => {
    app.mount('#app')
  })
  useEventBus().sync.notify()
  useEventBus().playlistArchive.notify()
  useEventBus().playlistLoad.notify()
  useEventBus().notesLoad.notify()
  useEventBus().subscriptionLoad.notify()

  /* -------------------------------------------------------------------------- */
  /*                          Initialization Analytics                          */
  /* -------------------------------------------------------------------------- */

  const elapsed = new Date().getTime() - start
  useAnalytics().track('app.init', { initTime: elapsed })
  useAnalytics().track('app.open')
  console.log(`Initialization time: ${elapsed}ms`)

})