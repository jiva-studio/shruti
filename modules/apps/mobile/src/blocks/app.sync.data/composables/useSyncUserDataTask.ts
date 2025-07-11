import { useLogger } from '@shruti/mobile/core'
import { InitOptions } from '../models/InitOptions'

export function useSyncUserDataTask(options: InitOptions) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.services.sync' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function sync() {
    try {
      logger.info('Sync started...')
      await onSync()
      logger.info('Sync completed successfully')
    } catch (error) {
      logger.error(`Sync failed: ${JSON.stringify(error)}`)
    }
  }
  
  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onSync() {
    const localDb = options.local()
    const remoteDb = options.remote()
    if (!localDb.userData || !remoteDb.userData) {
      logger.info('User data databases are not available for sync')
      return
    }

    // Document filters
    const userDocumentsToSync = (doc: any) => {
      return doc?.type && ['playlistItem', 'note', 'system'].includes(doc.type) 
    }

    // Sync user data
    await localDb.userData.sync(remoteDb.userData, { filter: userDocumentsToSync })
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { sync }

}