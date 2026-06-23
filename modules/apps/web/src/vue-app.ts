import type { App } from 'vue'
import { t } from './lib/i18n'

// Astro @astrojs/vue appEntrypoint: register the web app's global `$t` so the
// reused chat components (TranslationNotice, …) that read template-global `$t`
// resolve their labels — the same global the mobile app's i18n plugin provides.
export default (app: App) => {
  app.config.globalProperties.$t = t
}
