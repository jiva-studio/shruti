import { watch, Ref, toRaw } from 'vue'
import { storeToRefs } from 'pinia'
import { Storage } from '@ionic/storage'
import { useSyncDataStore } from './useSyncDataStore'
import { useLogger } from '@lectorium/mobile/core'

export function useSyncDataStorePersistenceTask() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const store = useSyncDataStore()
  const logger = useLogger({ module: 'app.sync.data' })

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const storage = new Storage({ name: 'config' })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  async function start() {
    logger.info('Starting sync persistence task...')
    await storage.create()
    await Promise.all([
      bind(storeToRefs(store).lastSyncedAt, 'sync.lastSyncedAt', 0),
    ])
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function bind<T>(
    config: Ref<T>, 
    key: string, 
    defaultValue: T
  ) {
    config.value = await storage.get(key) ?? defaultValue
    watch(config, async (value) => {
      logger.debug(`Updating '${key}' => '${JSON.stringify(value)}'`)
      await storage.set(key, toRaw(value))
    }, { deep: true })
    logger.info(`Bound '${key}' => '${JSON.stringify(config.value)}'`)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    start
  }
}