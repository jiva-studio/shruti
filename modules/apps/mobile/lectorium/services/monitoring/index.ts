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
import { isExpectedError } from "./isExpectedError.js"

// Redact email addresses from any outgoing string. Email is the only real PII
// the app handles and it isn't logged to the console anywhere — this is a cheap
// belt-and-suspenders so an address can never ride out in a message/breadcrumb.
// Opaque ids (userId / RevenueCat appUserId / deviceId) and sandbox file paths
// are NOT redacted: they're pseudonymous and useful for grouping/debugging.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi
const redactEmail = (s: string): string => s.replace(EMAIL_RE, "[email]")

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
        // Don't let the SDK attach IP / other PII automatically.
        sendDefaultPii: false,
        // Drop benign control-flow errors (expected `mkdir`-exists, aborted
        // requests, JSON.parse-of-cache, etc.) that the captureConsole bridge or
        // a reportError call might surface, and scrub email from the payload.
        beforeSend(event, hint) {
          if (isExpectedError(hint?.originalException)) return null
          if (event.message) event.message = redactEmail(event.message)
          for (const ex of event.exception?.values ?? []) {
            if (ex.value) ex.value = redactEmail(ex.value)
          }
          return event
        },
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.message) breadcrumb.message = redactEmail(breadcrumb.message)
          return breadcrumb
        },
        // @sentry/capacitor replaces `defaultIntegrations` with its own list,
        // which by design (see its integrations/default.js: "@sentry/vue
        // integrations must be added manually") does NOT include the Vue
        // integration — and `SentryVue.init`'s own attempt to add it is dropped
        // by the option spread. So it MUST be listed explicitly here, otherwise
        // app.config.errorHandler is never installed and Vue component
        // render/lifecycle errors reach Sentry as nothing. (Unhandled
        // exceptions and promise rejections are still caught by the default
        // globalHandlers integration regardless.)
        integrations: [
          SentryVue.vueIntegration({
            app,
            // Don't ship component props with events — they can carry user text.
            attachProps: false,
          }),
          // Escalate every `console.error` into a Sentry issue. The app's ~225
          // catch blocks swallow most failures (log-and-continue), so without
          // this Sentry would see almost nothing beyond unhandled crashes. Only
          // `error` level — `warn`/`info`/etc. stay breadcrumbs. Benign console
          // errors are filtered in beforeSend. Real failures that are SILENT or
          // only `console.warn` are reported explicitly via reportError().
          SentryVue.captureConsoleIntegration({ levels: ["error"] }),
        ],
      },
      SentryVue.init
    )
  } catch (e) {
    console.warn("[monitoring] Sentry init failed", e)
  }
}
