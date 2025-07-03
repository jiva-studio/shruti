import { createSharedComposable } from '@vueuse/core'
import * as amplitude from '@amplitude/analytics-browser'
import { ENVIRONMENT } from '@lectorium/mobile/env'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { watch } from 'vue'

export const useAnalytics = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()

  /* -------------------------------------------------------------------------- */
  /*                                    Init                                    */
  /* -------------------------------------------------------------------------- */

  if (ENVIRONMENT.amplitudeKey) {
    amplitude.init(ENVIRONMENT.amplitudeKey, {
      appVersion: `${ENVIRONMENT.release} (${ENVIRONMENT.dist})`,
      defaultTracking: false,
      autocapture: false,
      userId: config.userEmail.value || undefined
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  watch(config.userEmail, v => amplitude.setUserId(v))

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  function track(eventName: string, data?: any) {
    if (!ENVIRONMENT.amplitudeKey) { return }
    amplitude.track(eventName, data)
  }

  return { track }
})