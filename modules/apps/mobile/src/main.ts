import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ShrutiApp from './App.vue'
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
import { useTrackSearchFiltersPersistenceTask, useTracksSearchResults } from '@blocks/app.tracks.search.results'
import { useAnalytics } from '@blocks/app.analytics'

/* -------------------------------------------------------------------------- */
/*                                   Blocks                                   */
/* -------------------------------------------------------------------------- */

import { useEventBus } from '@shruti/mobile/core'
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


const pinia = createPinia()
const app = createApp(ShrutiApp)
  .use(IonicVue)
  .use(router)
  .use(useLocalization())
  .use(pinia)

useSentryFeature(app)

const start = new Date().getTime()

Promise.all([
  useConfigPersistenceTask().start(),
  useLocalDatabase().init(),
  useNavigationBar().init(),
  useSafeAreaTask().start(),
]).then(() => {

  // Should be initialized after config is loaded
  useRemoteDatabase().init({
    url: useConfig().databaseUrl.value,
    authToken: useConfig().authToken.value,
    userId: useConfig().userEmail.value
  }),

  router.isReady().then(async () => {
    // Mount the app as soon as the router is ready. Splash screen will be shown 
    // until the app is fully initialized.
    app.mount('#app')

    /* -------------------------------------------------------------------------- */
    /*                                Preload Data                                */
    /* -------------------------------------------------------------------------- */

    // await Promise.all([
    //   useDAL().tags.getAll({ limit: 1000 }),
    //   useDAL().authors.getAll({ limit: 1000 }),
    //   useDAL().sources.getAll({ limit: 1000 }),
    //   useDAL().locations.getAll({ limit: 1000 }),
    //   useDAL().languages.getAll({ limit: 1000 }),
    //   useDAL().durations.getAll({ limit: 1000 }),
    //   useDAL().sortMethods.getAll({ limit: 1000 }),
    // ])

    /* -------------------------------------------------------------------------- */
    /*                              Initialize Blocks                             */
    /* -------------------------------------------------------------------------- */

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
    useSubscription().init(useConfig().userEmail.value)
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
      useConfig().userEmail.value
    )

    /* -------------------------------------------------------------------------- */
    /*                               Setup Features                               */
    /* -------------------------------------------------------------------------- */

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
    useEventBus().playlistArchive.notify()
    useEventBus().notesLoad.notify()
    useEventBus().subscriptionLoad.notify()
    useEventBus().dictionaryLoad.notify()
    await useEventBus().playlistLoad.notify()

    /* -------------------------------------------------------------------------- */
    /*                          Initialization Analytics                          */
    /* -------------------------------------------------------------------------- */

    const elapsed = new Date().getTime() - start
    useAnalytics().track('app.init', { initTime: elapsed })
    useAnalytics().track('app.open')
    console.log(`Initialization time: ${elapsed}ms`)
    useEventBus().appReady.notify()
  })
})