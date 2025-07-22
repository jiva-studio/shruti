import { useLogger } from '@shruti/mobile/core'
import { createSharedComposable } from '@vueuse/core'
import { useSyncCommonDataTask } from './useSyncCommonDataTask'
import { useSyncUserDataTask } from './useSyncUserDataTask'
import { useSyncDataStore } from './useSyncDataStore'
import { InitOptions } from '../models/InitOptions'

export const useSyncData = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                Deoendencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.sync.data' })
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const syncInterval = 60 * 1000
  const store = useSyncDataStore()
  let userData: ReturnType<typeof useSyncUserDataTask> | null = null
  let commonData: ReturnType<typeof useSyncCommonDataTask> | null = null
  let pendingSyncPromise: Promise<void> | null = null

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  async function init(options: InitOptions) {
    userData = useSyncUserDataTask(options)
    commonData = useSyncCommonDataTask(options)
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Signals                                  */
  /* -------------------------------------------------------------------------- */

  async function sync() {
    if (!commonData || !userData) {
      throw new Error('useSyncData is not initialized. Call init(options) first.')
    }

    // If a sync is already in progress, return the pending promise
    if (pendingSyncPromise) { return pendingSyncPromise }

    // Check if last sync was less than syncInterval seconds ago. If so, schedule a sync after
    // the syncInterval window and return the pending promise.
    const now = Date.now()
    if (now - store.lastSyncedAt < syncInterval) {
      const timeUntilNextSync = syncInterval - (now - store.lastSyncedAt)
      pendingSyncPromise = new Promise((resolve) => {
        setTimeout(async () => {
          await performSync()
          resolve()
        }, timeUntilNextSync)
      })
      return pendingSyncPromise
    }

    // Perform sync immediately if no recent sync
    return performSync()
  }

  async function performSync() {
    if (!commonData || !userData) return

    store.isSyncing = true

    try {
      await Promise.all([
        commonData.sync(),
        userData.sync(),
      ])
      store.lastSyncedAt = Date.now()
    } catch (error) {
      logger.error('Sync failed', error)
    } finally {
      store.isSyncing = false
      pendingSyncPromise = null
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    commonData,
    userData,
    store,
    sync,
    init,
  }
})