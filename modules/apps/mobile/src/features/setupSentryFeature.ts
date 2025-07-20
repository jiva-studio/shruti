import { useSentry } from '@blocks/app.infra.sentry'
import { useEventBus } from '@shruti/mobile/core'

export function setupSentryFeature() {
  /* -------------------------------------------------------------------------- */
  /*                                Dependencies                                */
  /* -------------------------------------------------------------------------- */

  const sentry = useSentry()
  const eventBus = useEventBus()

  /* -------------------------------------------------------------------------- */
  /*                                    Hooks                                   */
  /* -------------------------------------------------------------------------- */

  eventBus.authSignInEnd.subscribe(async (data) => {
    sentry.setUserInfo({ id: data.userId })
  })

  eventBus.authSignOut.subscribe(async () => {
    sentry.setUserInfo(null)
  })
}