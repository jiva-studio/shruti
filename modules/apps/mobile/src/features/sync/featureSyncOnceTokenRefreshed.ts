import { useEventBus, useLogger } from '@shruti/mobile/core'

export function featureSyncOnceTokenRefreshed() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'featureSyncOnceTokenRefreshed' })
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authTokenRefreshed.subscribe(async () => {
    logger.info('Token refreshed. Start syncing...')
    eventBus.sync.notify()
  })
}