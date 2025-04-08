import './shared/assets/main.css'

import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import router from './router'

import StyleClass from 'primevue/styleclass'
import Ripple from 'primevue/ripple'
import PrimeVue from 'primevue/config'
import Tooltip from 'primevue/tooltip'
import Aura from '@primevue/themes/aura'
import { configureAxios } from './axios'

import { messages as authMessages } from '@lectorium/admin/auth'
import { messages as sharedMessages } from '@lectorium/admin/shared'

import 'primeicons/primeicons.css'

configureAxios()

const i18n = createI18n({
  locale: 'ru',
  fallbackLocale: 'en',
  messages: {
    en: {
      auth: authMessages.en,
      shared: sharedMessages.en,
    },
    ru: {
      auth: authMessages.ru,
      shared: sharedMessages.ru,
    },
  },
})

const app = createApp(App)

app.use(router)
app.use(i18n)
app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
  ripple: true,
})

app.directive('ripple', Ripple)
app.directive('styleclass', StyleClass)
app.directive('tooltip', Tooltip)

app.mount('#app')
