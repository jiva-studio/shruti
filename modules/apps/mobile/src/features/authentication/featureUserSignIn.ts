import { useAuth } from '@blocks/app.auth'
import { useEventBus, useLogger } from '@shruti/mobile/core'

export function featureUserSignIn() {

  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const auth = useAuth()
  const logger = useLogger({ module: 'featureUserSignIn' })
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignIn.subscribe(async (event) => {
    logger.info(`Signing in with ${event.provider}...`)

    const result = await auth.signIn(event.provider)
    if (!result) { return }

    await eventBus.authSignedIn.notify({
      userId: result.userId,
      userFirstName: result.userFirstName,
      userLastName: result.userLastName,
      userImageUrl: result.userImageUrl ?? undefined,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  })

}