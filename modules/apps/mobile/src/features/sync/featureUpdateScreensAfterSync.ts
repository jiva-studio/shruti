import { useEventBus } from '@lectorium/mobile/core'

export async function featureUpdateScreensAfterSync() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.syncComplete.subscribe(async () => {
    eventBus.playlistLoad.notify()
    eventBus.trackStateLoad.notify(['completed', 'inPlaylist'])
  })
}