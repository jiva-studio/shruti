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
 */

// Message signatures that are always expected/benign across the app's adapters.
// The network signatures (`Failed to fetch`, `unreachable`, iOS "connection
// lost/offline/Load failed") are expected on flaky mobile networks — every HTTP
// call site has failover + retry, and a genuine backend fault surfaces as a
// distinct `HTTP 5xx` message, so real outages are NOT hidden by these.
const EXPECTED_MESSAGE =
  /already exists|does not exist|no such (table|column)|no transaction is active|(start|begin) a transaction within a transaction|abort(ed|error)|not allowed to make the purchase|Failed to fetch|servers are unreachable|network unreachable|network error has occurred|Сетевое соединение потеряно|The Internet connection appears to be offline|Load failed/i

// Error class names that are control-flow, not faults: request cancellation,
// user-cancelled IAP, a store-refused purchase (IAP disabled on this build /
// restricted account / unsupported region), and JSON.parse failures on
// cached/persisted blobs (every such site has an explicit fallback — a real
// syntax bug would surface as an unhandled error via the global handlers, not
// here).
const EXPECTED_NAMES = new Set([
  "AbortError",
  "PurchaseCancelledError",
  "PurchaseNotAllowedError",
  "SyntaxError",
  // Our own connectivity wrapper (services/http/networkError.ts) — thrown when
  // a request can't reach any server. Every call site has failover + retry; a
  // real backend fault surfaces as a distinct `HTTP 5xx`, not a NetworkError.
  "NetworkError",
])

// RevenueCat error codes (the Capacitor bridge attaches PURCHASES_ERROR_CODE as
// a numeric-string `.code`). These are transient/environmental, not app faults,
// and must not page Sentry:
//   "2"  STORE_PROBLEM_ERROR
//   "10" NETWORK_ERROR              ("Error performing request." on flaky/offline networks)
//   "23" CONFIGURATION_ERROR        (empty offerings — App reviewers / sandbox / Mac Catalyst
//                                     with no provisioned StoreKit products; the app still works
//                                     in free mode). NOTE: this also hides a genuine store-wide
//                                     misconfiguration — see the breadcrumb mitigation in the store.
//   "32" PRODUCT_REQUEST_TIMED_OUT_ERROR
//   "35" OFFLINE_CONNECTION_ERROR
const EXPECTED_RC_CODES = new Set(["2", "10", "23", "32", "35"])

export function isExpectedError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name
    if (typeof name === "string" && EXPECTED_NAMES.has(name)) return true
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && EXPECTED_RC_CODES.has(code)) return true
  }
  // Read the message off Errors, raw strings, AND plain objects. Capacitor
  // plugin rejections and `console.error(obj)` calls arrive as `{code, message}`
  // objects (not Error instances), so an `instanceof Error`-only check let their
  // benign "already exists" / "does not exist" signatures through to Sentry.
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : ""
  return EXPECTED_MESSAGE.test(message)
}
