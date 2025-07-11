import { useSyncCommonDataTask } from './useSyncCommonDataTask'
import { useSyncUserDataTask } from './useSyncUserDataTask'
import { useSyncDataStore } from './useSyncDataStore'
import { InitOptions } from '../models/InitOptions'
import { createSharedComposable } from '@vueuse/core'


export const useSyncData = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const store = useSyncDataStore()
  let userData: ReturnType<typeof useSyncUserDataTask> | null = null
  let commonData: ReturnType<typeof useSyncCommonDataTask> | null = null

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

    store.isSyncing = true

    try {
      await Promise.all([
        commonData.sync(),
        userData.sync(),
      ])
      store.lastSyncedAt = Date.now()
    } catch (error) {
      console.error('Sync failed:', error)
    } finally {
      store.isSyncing = false
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
    init
  }
})