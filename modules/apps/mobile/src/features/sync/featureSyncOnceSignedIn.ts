import { useEventBus, useLogger } from '@lectorium/mobile/core'

export function featureSyncOnceSignedIn() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'featureSyncOnceSignedIn' })
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async () => {
    logger.info('User authenticated. Start syncing...')
    eventBus.sync.notify()
  })
}