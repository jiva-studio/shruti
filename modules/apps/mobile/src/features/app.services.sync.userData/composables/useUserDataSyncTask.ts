import { useLogger } from '@lectorium/mobile/features/app.core'
import { Database } from '@lectorium/dal/persistence'

type SyncDatabases = {
  userData?: Database
}

export type Options = {
  localDatabasesSource: SyncDatabases
  remoteDatabasesSource: SyncDatabases
}

/**
 * Task for synchronizing common data between local and remote db. 
 */
export function useUserDataSyncTask(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.services.sync.userData' })

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
    const localDb = options.localDatabasesSource
    const remoteDb = options.remoteDatabasesSource
    if (!localDb.userData || !remoteDb.userData) {
      logger.error('User data databases are not available for sync')
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