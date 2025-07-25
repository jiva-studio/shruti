import { useLogger } from '@shruti/mobile/core'
import { InitOptions } from '../models/InitOptions'
import { SyncResult } from '@shruti/dal/persistence'

/**
 * Task for synchronizing common data between local and remote db. 
 */
export function useSyncCommonDataTask(options: InitOptions) {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const logger = useLogger({ module: 'app.services.sync.commonData' })

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  async function sync() : Promise<SyncResult> {
    try {
      logger.info('Sync started...')
      const result = await onSync()
      logger.info('Sync completed successfully')
      return result
    } catch (error: any) {
      logger.error(`Sync failed: ${JSON.stringify(error)}`)
      throw new Error(`Sync failed.`, { cause: error })
    }
  }
  
  /* -------------------------------------------------------------------------- */
  /*                                  Handlers                                  */
  /* -------------------------------------------------------------------------- */

  async function onSync() : Promise<SyncResult> {
    const localDb = options.local()
    const remoteDb = options.remote()

    // Document filters
    const ignoreSystemDocs = (doc: any) => { 
      return doc._id && !doc._id.startsWith('_design/') 
    }

    // Execute all sync tasks in parallel
    const [ 
      indexSyncResult, 
      tracksSyncResult, 
      dictionarySyncResult 
    ] = await Promise.all([
      localDb.index.replicateFrom(remoteDb.index, { filter: ignoreSystemDocs }),
      localDb.tracks.replicateFrom(remoteDb.tracks, { filter: ignoreSystemDocs }),
      localDb.dictionary.replicateFrom(remoteDb.dictionary, { filter: ignoreSystemDocs }),
    ])

    return {
      pull: {
        docs: [
          ...indexSyncResult?.pull?.docs || [],
          ...tracksSyncResult?.pull?.docs || [],
          ...dictionarySyncResult?.pull?.docs || []
        ],
      }
    }
  }

  // Interface
  return { sync }
}