import { useSyncCommonDataTask } from './useSyncCommonDataTask'
import { useSyncUserDataTask } from './useSyncUserDataTask'
import { useSyncDataStore } from './useSyncDataStore'
import { InitOptions } from '../models/InitOptions'
import { createSharedComposable } from '@vueuse/core'

export const useSyncData = createSharedComposable(() => {
  
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const syncInterval = 10 * 1000 // 10 seconds
  const store = useSyncDataStore()
  let userData: ReturnType<typeof useSyncUserDataTask> | null = null
  let commonData: ReturnType<typeof useSyncCommonDataTask> | null = null
  let lastSyncTime: number | null = null
  let isSyncPending = false
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
    if (isSyncPending) {
      if (pendingSyncPromise) return pendingSyncPromise
      return Promise.resolve()
    }

    // Check if last sync was less than 60 seconds ago
    const now = Date.now()
    if (lastSyncTime && now - lastSyncTime < syncInterval) {
      // Schedule a sync for after the 60-second window
      const timeUntilNextSync = syncInterval - (now - lastSyncTime)
      isSyncPending = true
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

    isSyncPending = true
    store.isSyncing = true

    try {
      await Promise.all([
        commonData.sync(),
        userData.sync(),
      ])
      lastSyncTime = Date.now()
      store.lastSyncedAt = lastSyncTime
    } catch (error) {
      console.error('Sync failed:', error)
    } finally {
      store.isSyncing = false
      isSyncPending = false
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