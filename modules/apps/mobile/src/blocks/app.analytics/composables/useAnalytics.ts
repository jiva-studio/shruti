import * as amplitude from '@amplitude/analytics-browser'
import { createSharedComposable } from '@vueuse/core'
import { ENVIRONMENT } from '@shruti/mobile/env'
import { useLogger } from '@shruti/mobile/core'

export const useAnalytics = createSharedComposable(() => {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.analytics' })

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(userId: string | undefined) {
    if (!ENVIRONMENT.amplitudeKey) { 
      logger.info('Analytics key is not set, analytics will not be initialized.')
      return 
    }
    amplitude.init(ENVIRONMENT.amplitudeKey, {
      appVersion: `${ENVIRONMENT.release} (${ENVIRONMENT.dist})`,
      defaultTracking: false,
      autocapture: false,
      userId: userId
    })
    logger.info('Analytics initialized successfully.')
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Actions                                  */
  /* -------------------------------------------------------------------------- */

  function setUserId(userId: string | undefined) {
    if (!ENVIRONMENT.amplitudeKey) { return }
    amplitude.setUserId(userId)
    logger.info(`User ID set to: ${userId || 'undefined'}`)
  }

  function track(eventName: string, data?: any) {
    if (!ENVIRONMENT.amplitudeKey) { return }
    amplitude.track(eventName, data)
    logger.info(`${eventName} -> ${JSON.stringify(data)}`)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, track, setUserId }
})