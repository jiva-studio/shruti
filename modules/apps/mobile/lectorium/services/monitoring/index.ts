/**
 * Sentry crash + error monitoring.
 *
 * Wires the Capacitor SDK (native iOS/Android crash handling) together with
 * its Vue sibling (WebView JS errors + Vue component context) in a single
 * init, exactly as the Sentry "Ionic" guide prescribes — `@sentry/capacitor`
 * owns the native layer and forwards `@sentry/vue` via `SentryVue.init` so a
 * crash on either side lands in the same project.
 *
 * Init must happen after `createApp(...)` (the Vue error handler needs the
 * live app) but before `app.mount(...)`, so it is driven from `main.ts`.
 */
import { Capacitor } from "@capacitor/core"
import * as Sentry from "@sentry/capacitor"
import * as SentryVue from "@sentry/vue"
import type { App } from "vue"

// Public, embed-by-design DSN baked in at build time (see vite.config.ts),
// mirroring the OAuth client IDs. An empty string disables Sentry entirely.
declare const __SENTRY_DSN__: string
// Release name shared with the source-map upload — `lectorium@<version>+<sha>`.
declare const __SENTRY_RELEASE__: string
declare const __BUILD_ID__: string

let initialised = false

/**
 * Initialise Sentry. Idempotent, and defensive — a Sentry failure must never
 * break app startup.
 *
 * Skipped entirely when there is no DSN (mirrors the empty-RevenueCat-key
 * convention), or during a local web `npm run dev` session so the Sentry
 * project isn't flooded with events from hot-reloads. Native builds always
 * report, even debug ones, so on-device crashes are visible while testing.
 */
export function initMonitoring(app: App): void {
  if (initialised) return

  const dsn = __SENTRY_DSN__
  const isDev = __BUILD_ID__ === "dev"
  if (!dsn || (isDev && !Capacitor.isNativePlatform())) return
  initialised = true

  try {
    Sentry.init(
      {
        dsn,
        // Must match the source-map artifact name uploaded at build time
        // (vite.config.ts → sentryRelease) or maps won't resolve.
        release: __SENTRY_RELEASE__,
        environment: isDev ? "development" : "production",
        // Error monitoring only — no performance tracing (keeps quota and
        // payloads low). Raise tracesSampleRate later if transactions are wanted.
        tracesSampleRate: 0,
        siblingOptions: {
          vueOptions: {
            // Vue's App structurally satisfies the SDK's loose `Vue` shape.
            app,
            attachErrorHandler: true,
            // Don't ship component props with events — they can carry user text.
            attachProps: false,
          },
        },
      },
      SentryVue.init
    )
  } catch (e) {
    console.warn("[monitoring] Sentry init failed", e)
  }
}
