import { useSentry } from '@blocks/app.infra.sentry'
import { useEventBus } from '@lectorium/mobile/core'

export function featureSentrySetUserInfo() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const sentry = useSentry()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignedIn.subscribe(async (event) => {
    sentry.setUserInfo({ id: event.userId })
  })

  eventBus.authSignOut.subscribe(async () => {
    sentry.setUserInfo(null)
  })
}