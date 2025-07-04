import { watch, Ref, toRaw } from 'vue'
import { Storage } from '@ionic/storage'
import { useConfig } from './useConfig'
import { useLogger } from '@lectorium/mobile/features/app.core'
import { ENVIRONMENT } from '@lectorium/mobile/env'

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
    await Promise.all([
      bind(config.appLanguage, 'app.language', '??'),
      bind(config.subscriptionPlan, 'app.subscription.plan', ''),
      bind(config.showPlayerProgress, 'app.player.progress.show', true),
      bind(config.showNotesTab, 'app.notes.tab.show', true),
      bind(config.highlightCurrentSentence, 'app.transcript.highlightCurrentSentence', true),
      bind(config.savedTracksFilter, 'app.tracks.filter', { authors: ['acbsp'], sort: 'reference' }),
      bind(config.userName, 'app.user.name', ''),
      bind(config.userEmail, 'app.user.email', ''),
      bind(config.userAvatarUrl, 'app.user.avatar', ''),
      bind(config.authToken, 'app.auth.authToken', ENVIRONMENT.readonlyAuthToken),
      bind(config.authTokenExpiresAt, 'app.auth.authToken.expiresAt', 0),
      bind(config.refreshToken, 'app.auth.refreshToken', ''),
      bind(config.openTranscriptAutomatically, 'app.transcript.openAutomatically', true),
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