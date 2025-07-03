import { createApp, watch } from 'vue'
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
import * as amplitude from '@amplitude/analytics-browser'
import { Purchases } from '@revenuecat/purchases-capacitor'
import { Device } from '@capacitor/device'
import { initTrackSearchFeature } from './init/initTrackSearchFeature'
import { useTracksCountFeature } from './features/tracks.count'
import { useTracksDownloadTask } from './features/tracks.download'
import { locale } from './features/app.localization'
import { useCleanupMediaItemsFeature, useMarkCompletedPlaylistItem, usePlaylistFeature, useSyncPlaylistStoreTask } from './features/playlist'
import { useBucketService } from './features/app.services.bucket'
import { useConfig, useConfigPersistenceTask } from './features/app.config'
import { useDAL, useDatabase } from './features/app.database'
import { useSentryFeature } from './features/app.infra.sentry'
import { useNavigationBarAppearanceTask, useSafeAreaTask } from './features/app.appearance'
import { useCleanupFilesFeature } from './features/app.storage'
import { usePlayerControls, useSetPlayerControlsInfoFeature, useSyncAudioPlayerPluginStateFeature } from './features/player'
import { useSyncTranscriptTask, useTranscriptStore } from './features/transcript'
import { useNotesLoader, useNotesSearchIndex, useNotesSearchTask, useNotesStore } from './features/notes'
import { useRestoreSubscriptionPlan } from './features/app.purchases'
import { useTrackSearchFiltersPersistenceTask } from './features/tracks.search.results'
import { useAnalytics, useAnalyticsRecorderTask } from './features/app.analytics'
import { AuthenticationResponse, initSocialAuth, useAppleAuthentication, useGoogleAuthentication, useUserAvatarDownloader } from './features/app.auth'
import { useCommonDataSyncTask } from './features/app.services.sync.commonData'
import { Events, Slots } from './events'
import { useUserDataSyncTask } from './features/app.services.sync.userData'
import { useMediaSyncTask } from './features/app.services.sync.media'
import { useIdGenerator } from './features/app.core'
import { useDownloadingTask } from './features/app.services.download'
import { initTrackState, useSyncDownloadingStateTask, useSyncPlaylistStateTask } from './features/tracks.state'
import { useDebounceFn } from '@vueuse/core'
import { useSyncStore } from './features/app.services.sync'
import { Routes } from '@lectorium/protocol/index'
import { ENVIRONMENT } from './env'
import { useUserInfo } from './features/app.user.info'

const i18n = createI18n({
  locale: 'ru',
  fallbackLocale: 'en',
  messages: locale
})
const pinia = createPinia()
const app = createApp(LectoriumApp)
  .use(IonicVue)
  .use(router)
  .use(i18n)
  .use(pinia)

useSentryFeature(app)


router.isReady().then(async () => {
  const start = new Date().getTime()


  // Core //
  await useConfigPersistenceTask().start()
  
  /**
   * Initialize local and remote databases.
   */
  await useDatabase().init({
    remoteDatabaseUrl: useConfig().databaseUrl.value,
    remoteDatabaseAuthToken: () => {
      const token = useConfig().authToken.value
      return token
    },
    remoteUserDataCollectionName: () => {
      if (!useConfig().userEmail.value) { return '' }
      const dbname = 'users-' + useConfig().userEmail.value?.replace(/[^a-zA-Z0-9_]/g, '-')
      return dbname
    }
  })

  // App //

  useAnalyticsRecorderTask()

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

  initTrackSearchFeature()

  const dal = useDAL()
  await useTracksCountFeature().init({
    tracksService: dal.tracks
  })
  usePlaylistFeature().init({
    playlistService: dal.playlistItems,
  })
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


  await useTrackSearchFiltersPersistenceTask().start()


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

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const databases = useDatabase().get()
  const userInfo = useUserInfo({ database: databases.local.userData })


  /* -------------------------------------------------------------------------- */
  /*                               Authentication                               */
  /* -------------------------------------------------------------------------- */

  await initSocialAuth({
    googleOAuthClientId: ENVIRONMENT.googleWebClientId,
    appleOAuthClientId: ENVIRONMENT.iOSClientId,
  })

  Events.authenticationRequestedEvent.subscribe(async (event) => {
    const authenticateUrl = Routes(config.apiUrl.value).auth.signIn('jwt')
    let results: AuthenticationResponse|null = null
    if (event.provider === 'google') {
      results = await useGoogleAuthentication({ authenticateUrl }).authenticate()
    } else if (event.provider === 'apple') {
      results = await useAppleAuthentication({ authenticateUrl }).authenticate()
    }
    if (results === null) { return } // user canceled the login

    // update config with user data and tokens
    config.authToken.value = results?.accessToken || ''
    config.refreshToken.value = results?.refreshToken || ''
    config.userName.value = `${results?.userFirstName} ${results?.userLastName}`.trim()
    config.userEmail.value = results?.userEmail || ''
   
    if (config.authToken.value) {
      const parts = config.authToken.value.split('.')
      const payload = JSON.parse(atob(parts[1]))
      if (payload.exp) { config.authTokenExpiresAt.value = payload.exp * 1000 }
    }

    // download avatar image if available
    if (results.avatarUrl) {
      const avatar = await useUserAvatarDownloader().download(results.avatarUrl)
      config.userAvatarUrl.value = avatar || ''
    }

    // persist user info in database for further use
    await userInfo.save({
      name: config.userName.value,
      email: config.userEmail.value,
      avatarUrl: results.avatarUrl || undefined,
    })
    
    // Sync data and restore subscription plan
    Events.syncRequested.notify()
    Events.restoreSubscriptionPlanRequested.notify()
  })

  Events.logOutRequestedEvent.subscribe(async () => {
    config.authToken.value = ENVIRONMENT.readonlyAuthToken
    config.refreshToken.value = ''
    config.userName.value = ''
    config.userEmail.value = ''
    config.userAvatarUrl.value = ''
    config.subscriptionPlan.value = ''
    config.authTokenExpiresAt.value = 0
    await Purchases.logOut()
    amplitude.setUserId(undefined)
  })

  /* -------------------------------------------------------------------------- */
  /*                                Subscriptions                               */
  /* -------------------------------------------------------------------------- */

  await useInAppPurchasesFeatures().init()

  Events.restoreSubscriptionPlanRequested.subscribe(async () => {
    await useRestoreSubscriptionPlan().restore()
  })

  /* -------------------------------------------------------------------------- */
  /*                                  Playlist                                  */
  /* -------------------------------------------------------------------------- */

  Events.playlistUpdateRequested.subscribe(async (event) => {
    useSyncPlaylistStoreTask({
      playlistItemService: dal.playlistItems,
    }).sync(event.language)
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Sync                                    */
  /* -------------------------------------------------------------------------- */

  const debouncedFn = useDebounceFn(async () => {
    try {
      useSyncStore().isSyncing = true

      // refresh authToken
      const now = Date.now()
      const authTokenExpiresAt = useConfig().authTokenExpiresAt.value
      const authTokenTTL = authTokenExpiresAt - now
      const authTokenIsAboutToExpire = authTokenTTL < 15 * 60 * 1000 // 15 minutes
      const shouldUpdateAuthToken = authTokenIsAboutToExpire && config.refreshToken.value 

      if (shouldUpdateAuthToken) {
        const response = await fetch(
          Routes(config.apiUrl.value).auth.tokens.refresh(), 
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              refreshToken: config.refreshToken.value
            }),
          })

        if (response.ok) {
          const tokens = await response.json()
          config.authToken.value = tokens.accessToken
          config.refreshToken.value = tokens.refreshToken
        } else {
          // TODO: logout user if unable to refresh token and it is expired
        }
      }

      // sync common data
      await useCommonDataSyncTask({
        localDatabasesSource: useDatabase().get().local,
        remoteDatabasesSource: useDatabase().get().remote,
      }).sync()
      Events.syncTaskCompleted.notify({ task: 'commonData' })

      // sync user data
      if (useDatabase().get().remote) {
        await useUserDataSyncTask({
          localDatabasesSource: useDatabase().get().local,
          remoteDatabasesSource: useDatabase().get().remote,
        }).sync()
        Events.syncTaskCompleted.notify({ task: 'userData' })
      }

      // sync media items
      const result = await useMediaSyncTask({
        mediaItemsService: useDAL().mediaItems,
        playlistItemsService: useDAL().playlistItems,
      }).sync()
      result.newTrackIds.forEach((trackId) => {
        Events.trackDownloadRequested.notify({ trackId })
      })
      Events.syncTaskCompleted.notify({ task: 'media' })

      // sync user info
      const res = await userInfo.load()
      if (res && res.name)  { config.userName.value = res.name }
      // if (res && res.email) { config.userEmail.value = res.email }
      if (res?.avatarUrl) {
        const avatar = await useUserAvatarDownloader().download(res.avatarUrl)
        config.userAvatarUrl.value = avatar || ''
      }

    } finally {
      useSyncStore().isSyncing = false
      useSyncStore().lastSyncedAt = new Date().getTime()
    }
  }, 5000, { maxWait: 15000 })

  Events.syncRequested.subscribe(async () => {
    debouncedFn()
  })

  Events.syncTaskCompleted.subscribe(async (event) => {
    if (event.task === 'userData') { 
      await Events.playlistUpdateRequested.notify({ 
        language: useConfig().appLanguage.value
      })
      await Events.notesUpdateRequested.notify()
    }
  })

  useDAL().playlistItems.subscribe(async () => {
    Events.syncRequested.notify()
  })

  useDAL().notes.subscribe(async () => {
    Events.syncRequested.notify()
  })


  /* -------------------------------------------------------------------------- */
  /*                                 Downloader                                 */
  /* -------------------------------------------------------------------------- */

  Events.downloaderTaskEnqueueRequested.subscribe(async (event) => {
    const task = await useDownloadingTask({
      downloaderTaskFailedEvent: Events.downloaderTaskFailed,
      downloaderTaskStatusEvent: Events.downloaderTaskStatus,
      downloaderTaskEnqueuedEvent: Events.downloaderTaskEnqueued,
      downloaderTaskCompletedEvent: Events.downloaderTaskCompleted,
      getDownloaderTasksSlot: Slots.getDownloaderTasks
    })
    task.enqueue(event)
  })

  /* -------------------------------------------------------------------------- */
  /*                               Tracks Download                              */
  /* -------------------------------------------------------------------------- */

  Events.trackDownloadRequested.subscribe(async (event) => {
    useTracksDownloadTask({
      trackDownloadFailedEvent: Events.trackDownloadFailed,
      downloaderTaskFailedEvent: Events.downloaderTaskFailed,
      downloaderTaskCompletedEvent: Events.downloaderTaskCompleted,
      downloaderTaskEnqueueRequestedEvent: Events.downloaderTaskEnqueueRequested,
      bucketName: () => useConfig().bucketName.value,
      bucketService: () => useBucketService(),
      tracksService: () => useDAL().tracks,
      mediaItemsService: () => useDAL().mediaItems,
      uniqueIdGenerator: () => useIdGenerator().generateId(22)
    }).download(event.trackId)
  })

  /* -------------------------------------------------------------------------- */
  /*                                Tracks State                                */
  /* -------------------------------------------------------------------------- */

  await initTrackState({
    mediaItemsService: useDAL().mediaItems,
    playlistItemsService: useDAL().playlistItems
  })
  
  useSyncPlaylistStateTask({
    playlistItemService: dal.playlistItems
  })

  useSyncDownloadingStateTask({
    downloaderGetTasksSlot: Slots.getDownloaderTasks,
    downloaderTaskFailedEvent: Events.downloaderTaskFailed,
    downloaderTaskStatusEvent: Events.downloaderTaskStatus,
    downloaderTaskEnqueuedEvent: Events.downloaderTaskEnqueued,
  })

  /* -------------------------------------------------------------------------- */
  /*                                    Notes                                   */
  /* -------------------------------------------------------------------------- */
  
  Events.notesUpdateRequested.subscribe(async () => {
    await useNotesLoader({
      notesService: useDAL().notes,
      tracksService: useDAL().tracks,
      notesStore: useNotesStore()
    }).load()
  })

  /* -------------------------------------------------------------------------- */
  /*                                   Screens                                  */
  /* -------------------------------------------------------------------------- */

  useDAL().playlistItems.subscribe(async () => {
    Events.playlistUpdateRequested.notify({
      language: useConfig().appLanguage.value
    })
  })

  useDAL().notes.subscribe(async () => {
    Events.notesUpdateRequested.notify()
  })

  watch(config.appLanguage, (language: string) => {
    Events.playlistUpdateRequested.notify({ language })
  })

  /* -------------------------------------------------------------------------- */
  /*                             Fire Initial Events                            */
  /* -------------------------------------------------------------------------- */

  Events.syncRequested.notify()
  Events.playlistUpdateRequested.notify({ language: useConfig().appLanguage.value })
  Events.notesUpdateRequested.notify()
  Events.restoreSubscriptionPlanRequested.notify()

  /* -------------------------------------------------------------------------- */
  /*                          Initialization Analytics                          */
  /* -------------------------------------------------------------------------- */

  const elapsed = new Date().getTime() - start
  useAnalytics().track('app.init', { initTime: elapsed })
  useAnalytics().track('app.open')
  console.log(`Initialization time: ${elapsed}ms`)

  app.mount('#app')
})