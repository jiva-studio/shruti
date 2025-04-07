import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'

import StyleClass from 'primevue/styleclass'
import Ripple from 'primevue/ripple'
import PrimeVue from 'primevue/config'
import Tooltip from 'primevue/tooltip'
import Aura from '@primevue/themes/aura'
import 'primeicons/primeicons.css'

const app = createApp(App)

app.use(router)
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
