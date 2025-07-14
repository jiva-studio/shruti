import * as Sentry from '@sentry/capacitor'
import * as SentryVue from '@sentry/vue'
import { ENVIRONMENT } from '@shruti/mobile/env'
import { createSharedComposable } from '@vueuse/core'

type InitOptions = {
  app: any
  dsn: string
  release: string
  dist: string
}

export const useSentry = createSharedComposable(() => {

  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
/* -------------------------------------------------------------------------- */

  let options: InitOptions | undefined = undefined

  /* -------------------------------------------------------------------------- */
  /*                                 Initialize                                 */
  /* -------------------------------------------------------------------------- */

  function init(o: InitOptions) {
    options = o

    if (!ENVIRONMENT.sentryDsn) { return }

    Sentry.init(
      {
        app: options.app,
        dsn: options.dsn, 
        // Adds request headers and IP for users, for more info visit:
        // https://docs.sentry.io/platforms/javascript/guides/capacitor/configuration/options/#sendDefaultPii
        sendDefaultPii: true,
        // Set your release version, such as "getsentry@1.0.0"
        release: options.release,
        // Set your dist version, such as "1"
        dist: options.dist,
        integrations: [
          SentryVue.replayIntegration({
            maskAllText: false,
            maskAllInputs: false,
          }),
        ],
        replaysSessionSampleRate: 0.1,
        replaysOnErrorSampleRate: 1.0,
      },
      // Forward the init method from @sentry/angular
      SentryVue.init,
    )
  }

  function setUserId(userId: string | null) {
    if (!options) { return }
    if (!userId) {
      Sentry.setUser(null)
    } else {
      Sentry.setUser({ id: userId })
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                                  Interface                                 */
  /* -------------------------------------------------------------------------- */

  return { init, setUserId }

})