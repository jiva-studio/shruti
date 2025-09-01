import { useConfig } from '@blocks/app.config'
import { useEventBus, useLogger } from '@shruti/mobile/core'

export function featurePersistAuthentication() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const config = useConfig()
  const logger = useLogger({ module: 'featurePersistAuthentication' })
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async (event) => {
    logger.info('User authenticated. Persisting auth information...')
    config.userId.value = event.userId
    config.userName.value = `${event.userFirstName} ${event.userLastName}`.trim()
    config.authToken.value = event.accessToken
    config.refreshToken.value = event.refreshToken

    const parts = event.accessToken.split('.')
    const payload = JSON.parse(atob(parts[1]))
    if (payload.exp) { 
      config.authTokenExpiresAt.value = payload.exp * 1000 
    }
  })

  eventBus.authTokenRefreshed.subscribe(async (event) => {
    config.authToken.value = event.accessToken
    config.refreshToken.value = event.refreshToken

    const parts = event.accessToken.split('.')
    const payload = JSON.parse(atob(parts[1]))
    if (payload.exp) { 
      config.authTokenExpiresAt.value = payload.exp * 1000 
    }
  })

}