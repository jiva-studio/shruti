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
import { redactEmail, scrubEvent } from "./scrubEvent.js"
import { TRACE_PROPAGATION_TARGETS } from "./tracePropagationTargets.js"

// Public, embed-by-design DSN baked in at build time (see vite.config.ts),
// mirroring the OAuth client IDs. An empty string disables Sentry entirely.
declare const __SENTRY_DSN__: string
// Release name shared with the source-map upload — `shruti@<version>+<sha>`.
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
        // Tracing is on for ONE reason: a non-zero rate is what makes the SDK
        // attach `sentry-trace` / `baggage` to outgoing requests, which is what
        // lets the chat service continue the same trace server-side. So a crash
        // here and the backend error behind it become one story instead of two
        // unrelated issues in two systems. Deliberately modest — transactions
        // are billed per event and the value is the join, not a latency
        // dashboard. Errors are unaffected: they are sampled separately, at 100%.
        tracesSampleRate: 0.05,
        // Without this the SDK propagates only to same-origin and localhost
        // URLs, and every backend call is cross-origin to a `capacitor://`
        // page — so nothing would ever be propagated. Matched by origin rather
        // than by a fixed host list because the region list is fetched at
        // runtime from config.json (regionsRegistry), so a region flip or a new
        // region must not silently stop propagating. Anything not matched here
        // (the CDN, RevenueCat, the stores) is left untouched — headers are
        // sent only to hosts we control, never to third parties.
        tracePropagationTargets: [...TRACE_PROPAGATION_TARGETS],
        // Don't let the SDK attach IP / other PII automatically.
        sendDefaultPii: false,
        // Drop benign control-flow errors (expected `mkdir`-exists, aborted
        // requests, JSON.parse-of-cache, etc.) that the captureConsole bridge or
        // a reportError call might surface, and scrub email from the payload.
        beforeSend(event, hint) {
          if (isExpectedError(hint?.originalException)) return null
          return scrubEvent(event)
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
          // Required for the same reason the Vue integration below is:
          // @sentry/capacitor's default list (integrations/default.js) has no
          // browserTracing. It is what instruments `fetch`, and instrumented
          // fetch is what actually writes the `sentry-trace` header — so
          // without it `tracesSampleRate` alone changes nothing and the backend
          // has no trace to continue. The chat client uses fetch + a
          // ReadableStream (not EventSource, which can't carry headers), so it
          // is covered. No router is passed: navigation is driven by Ionic's
          // outlet, so the SDK's history-based spans are the accurate source.
          SentryVue.browserTracingIntegration(),
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

/**
 * Associate (or clear) the current user with subsequent Sentry events so errors
 * can be grouped per account ("this bug hit N users"). Only the opaque account
 * id is sent — never name, email, or IP (sendDefaultPii is off). Safe to call
 * before/without init — it's a no-op scope write when Sentry is disabled.
 */
export function setMonitoringUser(userId: string | null): void {
  Sentry.setUser(userId ? { id: userId } : null)
}

/**
 * Tag subsequent Sentry events with a low-cardinality, non-PII value (e.g. the
 * subscription tier) so issues can be filtered — "is this bug Pro-specific?".
 */
export function setMonitoringTag(key: string, value: string): void {
  Sentry.setTag(key, value)
}
