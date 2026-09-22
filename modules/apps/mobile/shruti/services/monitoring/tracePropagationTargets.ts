/**
 * Which URLs may carry the Sentry distributed-tracing headers.
 *
 * `sentry-trace` / `baggage` are what let the chat service continue the trace a
 * turn started on the device, so a client crash and the server error behind it
 * become one story. They must go to our backends and nowhere else — a header
 * sent to a third party (CDN, RevenueCat, the stores) leaks our trace ids and
 * can trip their own CORS allow-lists.
 *
 * Matched by origin PATTERN rather than a fixed host list because the region
 * list is not compiled in: it is fetched at runtime from config.json
 * (`regionsRegistry`), so a region flip or an added region would silently stop
 * propagating against a hardcoded list.
 *
 * Kept in its own module (like `isExpectedError`) so the patterns are testable
 * without importing the Sentry SDK.
 */

/**
 * Every region's auth/chat/profile/orchestrator host is an `<ip-dashed>.sslip.io`
 * name over https — see `@lib/domain/servers`. One pattern covers the regions
 * that ship today and any added later without an app release.
 */
export const SERVICE_ORIGIN_RE = /^https:\/\/(?:[\w.-]+\.sslip\.io|(?:api|ru)\.shruti\.local)(\/|$)/

/** The local dev stack (`local-stack`): chat on 11080, auth on 11081. */
export const DEV_ORIGIN_RE = /^http:\/\/localhost:110\d{2}(\/|$)/

/** Passed straight to `Sentry.init({ tracePropagationTargets })`. */
export const TRACE_PROPAGATION_TARGETS: readonly RegExp[] = [SERVICE_ORIGIN_RE, DEV_ORIGIN_RE]

/** True when `url` is a backend of ours and may receive the tracing headers. */
export function shouldPropagateTrace(url: string): boolean {
  return TRACE_PROPAGATION_TARGETS.some((re) => re.test(url))
}
