import { useConfig } from '@blocks/app.config'
import { useRemoteDatabase } from '@blocks/app.database'
import { useEventBus, useLogger } from '@lectorium/mobile/core'

export function featureSetRemoteDbCredentials() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const logger = useLogger({ module: 'featureSetRemoteDbCredentials' })
  const eventBus = useEventBus()
  const remoteDatabase = useRemoteDatabase()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async (event) => {
    logger.info(`User authenticated. Configuring remote databse...`)

    remoteDatabase.init({
      url: config.databaseUrl.value,
      userId: event.userId,
      authToken: event.accessToken,
    })
  })

  eventBus.authTokenRefreshed.subscribe(async (event) => {
    remoteDatabase.init({
      url: config.databaseUrl.value,
      userId: config.userId.value,
      authToken: event.accessToken,
    }) 
  })

}