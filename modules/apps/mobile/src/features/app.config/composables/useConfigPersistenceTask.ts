import { watch, Ref, toRaw } from 'vue'
import { Storage } from '@ionic/storage'
import { useConfig } from './useConfig'
import { useLogger } from '@lectorium/mobile/features/app.core'

export function useConfigPersistenceTask() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const logger = useLogger({ module: 'app.config' })

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  const storage = new Storage({ name: 'config' })

  /* -------------------------------------------------------------------------- */
  /*                               Initialization                               */
  /* -------------------------------------------------------------------------- */

  async function start() {
    logger.info('Starting config persistence task...')
    await storage.create()
    await bind(config.appLanguage, 'app.language', '??')
    await bind(config.subscriptionPlan, 'app.subscription.plan', '')
    await bind(config.showPlayerProgress, 'app.player.progress.show', true)
    await bind(config.showNotesTab, 'app.notes.tab.show', true)
    await bind(config.highlightCurrentSentence, 'app.transcript.highlightCurrentSentence', true)
  }

  /* -------------------------------------------------------------------------- */
  /*                                   Helpers                                  */
  /* -------------------------------------------------------------------------- */

  async function bind<T>(
    config: Ref<T>, 
    key: string, 
    defaultValue: T
  ) {
    config.value = await storage.get(key) || defaultValue
    watch(config, async (value) => {
      logger.debug(`Updating '${key}' => '${value}'`)
      await storage.set(key, toRaw(value))
    }, { deep: true })
    logger.info(`Bound '${key}' => '${config.value}'`)
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return {
    start
  }
}