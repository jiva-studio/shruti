import { createApp } from 'vue'
import { createPinia } from 'pinia'
import LectoriumApp from './App.vue'
import router from './router'

import { IonicVue } from '@ionic/vue'
import { SplashScreen } from '@capacitor/splash-screen'

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

/* -------------------------------------------------------------------------- */
/*                                   Blocks                                   */
/* -------------------------------------------------------------------------- */

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
import { useTracksSearchFilters } from '@blocks/app.tracks.search.filters'
import { usePlaylist } from '@blocks/app.playlist'
import { useConfig, useConfigPersistenceTask } from '@blocks/app.config'
import { useDAL, useLocalDatabase, useRemoteDatabase } from '@blocks/app.database'
import { useSentry } from '@blocks/app.infra.sentry'
import { useNavigationBar, useSafeAreaTask } from '@blocks/app.appearance'
import { useTranscriptLoader } from '@blocks/app.transcript'
import { useTrackSearchFiltersPersistenceTask, useTracksSearchResults } from '@blocks/app.tracks.search.results'
import { useAnalytics } from '@blocks/app.analytics'
import { useTracksCountFeature } from '@blocks/app.tracks.count'

/* -------------------------------------------------------------------------- */
/*                                    Setup                                   */
/* -------------------------------------------------------------------------- */

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
import { setupI18nFeature } from './features/setupI18nFeature'
import { setupTracksSearchFeature } from './features/setupTracksSearchFeature'
import { setupAnalyticsFeature } from './features/setupAnalyticsFeature'
import { setupAppearanceFeature } from './features/setupAppearanceFeature'
import { setupTutorialFeature } from './features/setupTutorialFeature'
import { setupToastFeature } from './features/setupToastFeature'
import { setupSentryFeature } from './features/setupSentryFeature'
import { setupAppStatusFeature } from './features/setupAppStatusFeature'
import { setupPlayerAnalyticsFeature } from './features/setupPlayerAnalyticsFeature'

/* -------------------------------------------------------------------------- */
/*                                    Misc                                    */
/* -------------------------------------------------------------------------- */

import { ENVIRONMENT } from './env'

/* -------------------------------------------------------------------------- */
/*                                    Init                                    */
/* -------------------------------------------------------------------------- */

const pinia = createPinia()
const app = createApp(LectoriumApp)
  .use(IonicVue)
  .use(router)
  .use(useLocalization())
  .use(pinia)

useSentry().init({
  app: app,
  dsn: ENVIRONMENT.sentryDsn,
  release: ENVIRONMENT.release,
  dist: ENVIRONMENT.dist,
})

const start = new Date().getTime()

Promise.all([
  useConfigPersistenceTask().start(),
  useLocalDatabase().init(),
  useNavigationBar().init(),
  useSafeAreaTask().start(),
]).then(() => {

  // Set user ID for Sentry
  useSentry().setUserInfo({
    id: useConfig().userId.value,
  })

  // Should be initialized after config is loaded
  useRemoteDatabase().init({
    url: useConfig().databaseUrl.value,
    authToken: useConfig().authToken.value,
    userId: useConfig().userId.value
  }),

  router.isReady().then(async () => {
    /* -------------------------------------------------------------------------- */
    /*                                Preload Data                                */
    /* -------------------------------------------------------------------------- */

    // NOTE: Load all dictionary data into memory, because it is used in many places
    //       and it is more efficient to have it in memory than to query the database 
    //       every time.
    await Promise.all([
      useDAL().tags.getAll({ limit: 1000 }),
      useDAL().authors.getAll({ limit: 1000 }),
      useDAL().sources.getAll({ limit: 1000 }),
      useDAL().locations.getAll({ limit: 1000 }),
      useDAL().languages.getAll({ limit: 1000 }),
      useDAL().durations.getAll({ limit: 1000 }),
      useDAL().sortMethods.getAll({ limit: 1000 }),
    ])

    /* -------------------------------------------------------------------------- */
    /*                              Initialize Blocks                             */
    /* -------------------------------------------------------------------------- */

    useBucketService().init({
      apiUrl: useConfig().apiUrl.value,
      authToken: useConfig().authToken.value,
    })
    useSyncData().init({
      local: () => useLocalDatabase().get(),
      remote: () => useRemoteDatabase().get(),
    })
    useSyncMedia().init({
      mediaItemsRepository: useDAL().mediaItems, 
      playlistItemsRepository: useDAL().playlistItems,
    })
    useTracksState().init({
      mediaItemsRepository: useDAL().mediaItems,
      playlistItemsRepository: useDAL().playlistItems,
    })
    useAuthTokenRefresher().init({
      apiUrl: useConfig().apiUrl.value,
    })
    // const userAvatarDownloader = useUserAvatarDownloader()
    useUserInfo().init({
      database: useLocalDatabase().get().userData,
    })
    useSubscription().init(useConfig().userId.value)
    useTrackMediaItems().init({
      bucketName: useConfig().bucketName.value,
      bucketService: useBucketService(),
      tracksRepository: useDAL().tracks,
      mediaItemsRepository: useDAL().mediaItems,
    })
    useTrackMediaItemsDownloader().init({ 
      mediaItemsRepository: useDAL().mediaItems,
      maxConcurrentDownloads: 3
    })
    useTracksSearchFilters().init({
      authorsService: useDAL().authors,
      sourcesService: useDAL().sources,
      locationsService: useDAL().locations,
      languagesService: useDAL().languages,
      durationsService: useDAL().durations,
      sortMethodsService: useDAL().sortMethods,
    })
    useTracksSearchResults().init({
      indexService: useDAL().index,
      tracksService: useDAL().tracksSearchService,
      sourcesRepository: useDAL().sources,
      durationsRepository: useDAL().durations,
    })
    useNotes().init({
      idGenerator: () => useIdGenerator().generateId(24),
      notesRepository: useDAL().notes,
      tracksRepository: useDAL().tracks,
    })
    useTranscriptLoader().init({
      authorsRepository: useDAL().authors,
      tracksRepository: useDAL().tracks,
      languagesRepository: useDAL().languages,
      notesRepository: useDAL().notes,
    })
    useTracksCountFeature().init({
      tracksRepo: useDAL().tracks
    })
    usePlaylist().init({
      playlistItemsRepository: useDAL().playlistItems,
      tracksRepository: useDAL().tracks,
      idGenerator: () => useIdGenerator().generateId(24),
    })
    useAnalytics().init(
      useConfig().userId.value
    )

    /* -------------------------------------------------------------------------- */
    /*                               Setup Features                               */
    /* -------------------------------------------------------------------------- */

    setupSentryFeature()
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
    setupToastFeature()
    setupAppStatusFeature()
    setupPlayerAnalyticsFeature()

    /* -------------------------------------------------------------------------- */
    /*                                    Misc                                    */
    /* -------------------------------------------------------------------------- */

    // TODO: put under related setupFeature 
    useTracksCountFeature().load()
    useTrackSearchFiltersPersistenceTask().start()

    /* -------------------------------------------------------------------------- */
    /*                             Fire Initial Events                            */
    /* -------------------------------------------------------------------------- */

    useEventBus().sync.notify()
    useEventBus().playlistArchiveCompleted.notify()
    useEventBus().notesLoad.notify()
    useEventBus().subscriptionLoad.notify()
    useEventBus().dictionaryLoad.notify()
    useEventBus().appStatusCheck.notify()
    await useEventBus().playlistLoad.notify()

    /* -------------------------------------------------------------------------- */
    /*                          Initialization Analytics                          */
    /* -------------------------------------------------------------------------- */

    const elapsed = new Date().getTime() - start
    useAnalytics().track('app.init', { initTime: elapsed })
    useAnalytics().track('app.open')
    console.log(`Initialization time: ${elapsed}ms`)

    app.mount('#app')
    await SplashScreen.hide()
  })
})