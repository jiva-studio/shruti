/**
 * Deny-list for benign, expected control-flow "errors" that must NOT become
 * Sentry issues.
 *
 * The app is written defensively: many operations can only be attempted and
 * caught (there's no cheap "exists?" probe), so a thrown value is often normal
 * control flow, not a bug — e.g. `Filesystem.mkdir` on a directory that already
 * exists, a `SELECT` against a table the (older) catalog DB doesn't have yet, a
 * `JSON.parse` of a corrupt/legacy cached blob with a sane fallback, an
 * `AbortError` from our own request timeouts, or a user-cancelled purchase.
 *
 * Both the `captureConsole` path (auto-escalated `console.error`) and the
 * explicit {@link reportError} helper run candidates through this so a benign
 * signature is dropped regardless of how it reached Sentry.
 *
 * PREFER typed errors over adding entries here. When WE own the throw/catch
 * seam, model the expected condition as a named error class and swallow it at
 * the call site (see `PurchaseCancelledError`, `NotificationsDisabledError`) —
 * that keeps intent at the source and never risks masking an unrelated failure
 * that happens to share a message or a generic class name. This list is only
 * for THIRD-PARTY / platform errors we can't tag at their origin (raw Capacitor
 * plugin rejections, RevenueCat numeric codes, platform network/WebKit strings).
 */

// A failed dynamic import means a broken deploy — a rotated chunk hash, a
// stale CDN edge — white-screening a lazy route, and must ALWAYS stay visible.
// Checked before the deny-list because the engines word it differently and two
// of those wordings sit inside benign network signatures: Chromium says
// `TypeError: Failed to fetch dynamically imported module: <url>`, which the
// bare `Failed to fetch` below matches as a substring. Anchoring that entry
// instead would be fragile — engines prepend/append their own context, and the
// non-Chromium wordings would still need listing here. WebKit's bare
// `Load failed` needs no entry: it is deliberately absent from the deny-list.
const DYNAMIC_IMPORT_FAILURE = /dynamically imported module|importing a module script failed/i

// Message signatures that are always expected/benign across the app's adapters.
// The network signatures (`Failed to fetch`, `unreachable`, iOS "connection
// lost / offline") are expected on flaky mobile networks — every HTTP call site
// has failover + retry, and a genuine backend fault surfaces as a distinct
// `HTTP 5xx` message, so real outages are NOT hidden by these. We deliberately
// do NOT list the bare WebKit "Load failed": our own fetches already rewrap to
// NetworkError, and "Load failed" would also mask a failed dynamic-import (a
// broken deploy white-screening iOS users) — which must stay visible.
//
// NB: "not open yet" is deliberately NOT here. It was added for SHRUTI-6
// ("repositories(): content DB is not open yet"), but the same commit fixed
// that noise at its source — the auto-download refill loop now logs the catch
// at warn level, which captureConsole never escalates. Every other caller that
// can race the DB open swallows the throw without logging. What the entry did
// keep suppressing is the signal itself: `repositories()` throwing IS a
// boot-ordering regression, and deny-listing it made those invisible.
//
// NB: "no such (table|column)" is deliberately NOT here either. It was added
// for the old-catalog-DB probe — a binary shipping ahead of the published
// schema — but that probe never reaches this filter: `collectionsRepository`
// catches it at the source (`isMissingTable` / `isMissingColumn`), returns an
// empty list and logs nothing. What the entry DID suppress is the observable
// symptom of a user-DB migration that threw: `runMigrations` stops the ordered
// list at the first failure, so every later migration stays unapplied and the
// app reads a table that was never created. That made a broken migration
// indistinguishable from a probe against an old DB (#1742).
//
// NB: "abort(ed|error)" is deliberately NOT here. Unanchored, it matched any
// message containing "aborted" — SQLITE_ABORT, an IndexedDB transaction abort
// — while every cancellation it was written for arrives as an AbortController
// rejection carrying `name: "AbortError"`, already covered by EXPECTED_NAMES.
const EXPECTED_MESSAGE =
  /already exists|does not exist|no transaction is active|(start|begin) a transaction within a transaction|not allowed to make the purchase|Failed to fetch|servers are unreachable|network unreachable|network error has occurred|Сетевое соединение потеряно|The Internet connection appears to be offline|Seek operation failed/i

// Error class names that are control-flow, not faults: request cancellation,
// user-cancelled IAP, and a store-refused purchase (IAP disabled on this build
// / restricted account / unsupported region).
//
// NB: "SyntaxError" is deliberately NOT here. It was once listed to cover
// JSON.parse of cached/persisted blobs, but every such site (10 of them, all
// under Preferences-backed stores) already has its own try/catch with a
// fallback, so a benign parse error never reaches this filter. Suppressing the
// whole class instead masked GENUINE SyntaxErrors (a real code bug, or a
// malformed dynamic-import chunk surfacing through the global handlers), so it
// must stay visible.
const EXPECTED_NAMES = new Set([
  "AbortError",
  "PurchaseCancelledError",
  "PurchaseNotAllowedError",
  // Our own connectivity wrapper (services/http/networkError.ts) — thrown when
  // a request can't reach any server. Every call site has failover + retry; a
  // real backend fault surfaces as a distinct `HTTP 5xx`, not a NetworkError.
  "NetworkError",
])

// RevenueCat error codes (the Capacitor bridge attaches PURCHASES_ERROR_CODE as
// a numeric-string `.code`). These are transient/environmental, not app faults,
// and must be silenced entirely:
//   "2"  STORE_PROBLEM_ERROR
//   "10" NETWORK_ERROR              ("Error performing request." on flaky/offline networks)
//   "32" PRODUCT_REQUEST_TIMED_OUT_ERROR
//   "35" OFFLINE_CONNECTION_ERROR
// NOTE: CONFIGURATION_ERROR ("23", empty offerings) is deliberately NOT here.
// It's benign for the user (free mode) but is the ONLY signal of a genuine
// store-wide product outage, so usePurchasesStore reports it at WARNING level
// instead of silencing it — visible as a trend without paging like a crash.
const EXPECTED_RC_CODES = new Set(["2", "10", "32", "35"])

// Capacitor plugin rejections and `console.error(obj)` calls arrive as plain
// `{code, message}` objects, not Errors, so read the message off all three.
function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return ""
}

function hasExpectedTag(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = (error as { name?: unknown }).name
  if (typeof name === "string" && EXPECTED_NAMES.has(name)) return true
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && EXPECTED_RC_CODES.has(code)
}

export function isExpectedError(error: unknown): boolean {
  if (hasExpectedTag(error)) return true
  const message = readErrorMessage(error)
  if (DYNAMIC_IMPORT_FAILURE.test(message)) return false
  return EXPECTED_MESSAGE.test(message)
}
