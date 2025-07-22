import { useLogger } from '@shruti/mobile/core'
import { InitOptions } from '../models/InitOptions'
import { SyncResult } from '@shruti/dal/persistence'

export function useSyncUserDataTask(options: InitOptions) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.services.sync' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function sync() : Promise<SyncResult> {
    try {
      logger.info('Sync started...')
      const syncResult = await onSync()
      logger.info('Sync completed successfully')
      return syncResult
    } catch (error) {
      logger.error(`Sync failed: ${JSON.stringify(error)}`)
      return {}
    }
  }
  
  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onSync() : Promise<SyncResult> {
    const localDb = options.local()
    const remoteDb = options.remote()
    if (!localDb.userData || !remoteDb.userData) {
      logger.info('User data databases are not available for sync')
      return {}
    }

    // Document filters
    const userDocumentsToSync = (doc: any) => {
      return doc?.type && ['playlistItem', 'note', 'system'].includes(doc.type) 
    }

    // Sync user data
    return await localDb.userData.sync(remoteDb.userData, { filter: userDocumentsToSync })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { sync }

}