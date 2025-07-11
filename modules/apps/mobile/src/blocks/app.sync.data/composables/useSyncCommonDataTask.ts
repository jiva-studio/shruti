import { useLogger } from '@shruti/mobile/core'
import { InitOptions } from '../models/InitOptions'

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