import * as Sentry from '@sentry/capacitor'
import * as SentryVue from '@sentry/vue'
import { ENVIRONMENT } from '@/app/env'

export function useSentryFeature(app: any) {
  if (!ENVIRONMENT.sentryDsn) { return }

  Sentry.init(
    {
      app,
      dsn: ENVIRONMENT.sentryDsn, 
      // Adds request headers and IP for users, for more info visit:
      // https://docs.sentry.io/platforms/javascript/guides/capacitor/configuration/options/#sendDefaultPii
      sendDefaultPii: true,
      // Set your release version, such as "getsentry@1.0.0"
      release: ENVIRONMENT.release,
      // Set your dist version, such as "1"
      dist: ENVIRONMENT.dist,
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