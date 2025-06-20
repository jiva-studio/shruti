import { createSharedComposable } from '@vueuse/core'
import * as amplitude from '@amplitude/analytics-browser'
import { ENVIRONMENT } from '@shruti/mobile/env'

export const useAnalytics = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                    Init                                    */
  /* -------------------------------------------------------------------------- */

  if (ENVIRONMENT.amplitudeKey) {
    amplitude.init(ENVIRONMENT.amplitudeKey, {
      appVersion: `${ENVIRONMENT.release} (${ENVIRONMENT.dist})`,
      defaultTracking: false,
      autocapture: false,
    })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  function track(eventName: string, data?: any) {
    if (!ENVIRONMENT.amplitudeKey) { return }
    amplitude.track(eventName, data)
  }

  return { track }
})