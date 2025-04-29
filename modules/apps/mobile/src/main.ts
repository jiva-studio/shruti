import { createApp } from 'vue'
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
import './app/theme/variables.css'

import { createI18n } from 'vue-i18n'
import { 
  useConfig,
  useConfigPersistenceFeature,
  useNavigationBarFeature,
  useSafeAreaFeature,
  useStatusBarFeature,
  useSyncMediaItemStatusesFeature,
  useCleanupMediaItemsFeature,
  useCleanupFilesFeature,
  useMarkCompletedPlaylistItem,
  useRemoveCompletedPlaylistItemsFeature,
  useDAL,
  useSentryFeature
} from './app'
import { 
  useSyncAudioPlayerPluginStateFeature, 
  useSetPlayerControlsInfoFeature,
} from '@/player'

/** 
 * Configure PouchDB to use SQLite adapter for Cordova
 */
import PouchDB from 'pouchdb'
import PouchDBAdapterSqlLite from 'pouchdb-adapter-cordova-sqlite'
PouchDB.plugin(PouchDBAdapterSqlLite)

import { locale as localeApp } from './app/locale'
import { locale as localeHome } from './home/locale'
import { locale as localeLibrary } from './library/locale'
import { locale as localeSettings } from './settings/locale'

const i18n = createI18n({
  locale: 'ru',
  fallbackLocale: 'en',
  messages: {
    en: {
      app: localeApp.en,
      home: localeHome.en,
      library: localeLibrary.en,
      settings: localeSettings.en,
    },
    ru: {
      app: localeApp.ru,
      home: localeHome.ru,
      library: localeLibrary.ru,
      settings: localeSettings.ru,
    }
  }
})

const app = createApp(App)
  .use(IonicVue)
  .use(router)
  .use(i18n)

useSentryFeature(app)


router.isReady().then(async () => {
  const start = new Date().getTime()

  // App //

  await useConfigPersistenceFeature()
  await useNavigationBarFeature()
  await useStatusBarFeature()
  await useSafeAreaFeature()
  await useSyncMediaItemStatusesFeature()
  useCleanupMediaItemsFeature()
  useCleanupFilesFeature()
  useMarkCompletedPlaylistItem()
  useRemoveCompletedPlaylistItemsFeature()

  // Player //

  useSyncAudioPlayerPluginStateFeature()
  useSetPlayerControlsInfoFeature()

  // Rest //

  const config = useConfig()
  i18n.global.locale = config.appLanguage.value as 'en' | 'ru'

  // Steps //

  const dal = useDAL()
  await dal.playlistItems.init()

  const elapsed = new Date().getTime() - start
  console.log(`Initialization time: ${elapsed}ms`)

  app.mount('#app')
})