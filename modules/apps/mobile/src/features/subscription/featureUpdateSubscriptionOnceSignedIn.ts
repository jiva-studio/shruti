import { useEventBus, useLogger } from '@shruti/mobile/core'

export function featureUpdateSubscriptionOnceSignedIn() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'featureUpdateSubscriptionOnceSignedIn' })
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async () => {
    logger.info('User authenticated. Update subcription...')
    eventBus.subscriptionLoad.notify()
  })
}