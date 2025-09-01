import { App } from '@capacitor/app'
import { useEventBus } from '@shruti/mobile/core'
import { useSyncDataStorePersistenceTask } from '@blocks/app.sync.data'
import { useDAL } from '@blocks/app.database'

export async function setupSyncFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const dal = useDAL()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  dal.playlistItems.subscribe(async () => {
    eventBus.sync.notify()
  })

  dal.notes.subscribe(async () => { 
    eventBus.sync.notify()
  })

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) { eventBus.sync.notify() }
  })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  await useSyncDataStorePersistenceTask().start()
}