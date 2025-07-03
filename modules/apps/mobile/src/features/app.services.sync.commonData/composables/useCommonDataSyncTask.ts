import { useLogger } from '@lectorium/mobile/features/app.core'
import { Database } from '@lectorium/dal/persistence'

type SyncDatabases = {
  index: Database
  tracks: Database
  dictionary: Database
}

export type Options = {
  localDatabasesSource: SyncDatabases
  remoteDatabasesSource: SyncDatabases
}

/**
 * Task for synchronizing common data between local and remote db. 
 */
export function useCommonDataSyncTask(options: Options) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.services.sync.commonData' })

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

    // Document filters
    const ignoreSystemDocs = (doc: any) => { 
      return doc._id && !doc._id.startsWith('_design/') 
    }

    // Execute all sync tasks in parallel
    await Promise.all([
      localDb.index.replicateFrom(remoteDb.index, { filter: ignoreSystemDocs }),
      localDb.tracks.replicateFrom(remoteDb.tracks, { filter: ignoreSystemDocs }),
      localDb.dictionary.replicateFrom(remoteDb.dictionary, { filter: ignoreSystemDocs }),
    ])
  }

  // Interface
  return { sync }
}